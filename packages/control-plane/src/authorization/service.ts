import {
  createRoleInputSchema,
  isRegisteredPermission,
  normalizeRoleName,
  permissionsForBuiltInRole,
  replaceRoleInputSchema,
  type BuiltInRoleKey,
  type EffectiveAuthorization,
  type PermissionId,
  type RoleSummary,
  type WorkspaceMember,
} from "@open-inspect/shared/rbac";
import { AuthorizationStore, type AuthorizationRoleRecord } from "../db/authorization-store";
import type { SqlDatabase } from "../db/sql-database";

export class AuthorizationError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly permission?: PermissionId
  ) {
    super(code);
    this.name = "AuthorizationError";
  }
}

export class RbacConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RbacConflictError";
  }
}

export class AuthorizationService {
  private readonly store: AuthorizationStore;

  constructor(db: SqlDatabase) {
    this.store = new AuthorizationStore(db);
  }

  async getEffectiveAuthorization(userId: string): Promise<EffectiveAuthorization> {
    const record = await this.store.getEffectiveAuthorization(userId);
    if (!record?.role) throw new AuthorizationError(403, "assignment_required");

    const permissions =
      record.suspendedAt === null
        ? await this.loadRolePermissions(record.role.id, record.role.key)
        : [];

    return {
      userId: record.userId,
      suspendedAt: record.suspendedAt,
      role: record.role,
      permissions,
    };
  }

  async requirePermission(
    userId: string,
    permission: PermissionId
  ): Promise<EffectiveAuthorization> {
    const authorization = await this.getEffectiveAuthorization(userId);
    if (authorization.suspendedAt !== null) {
      throw new AuthorizationError(403, "active_user_required");
    }
    if (!authorization.permissions.includes(permission)) {
      throw new AuthorizationError(403, "permission_required", permission);
    }
    return authorization;
  }

  async listRoles(): Promise<RoleSummary[]> {
    const roles = await this.store.listRoles();
    return Promise.all(roles.map((role) => this.toRoleSummary(role)));
  }

  async getRole(roleId: string): Promise<RoleSummary | null> {
    const role = await this.store.getRole(roleId);
    return role ? this.toRoleSummary(role) : null;
  }

  async createRole(input: unknown, actorUserId: string, requestId: string): Promise<RoleSummary> {
    const parsed = createRoleInputSchema.parse(input);
    const roleId = `role_${crypto.randomUUID()}`;
    try {
      await this.store.createRole({
        roleId,
        name: parsed.name,
        normalizedName: normalizeRoleName(parsed.name),
        description: parsed.description ?? null,
        permissions: parsed.permissions,
        actorUserId,
        requestId,
        now: Date.now(),
      });
    } catch (cause) {
      await this.rethrowMutationFailure(cause, actorUserId, ["workspace.roles.manage"]);
    }
    return (await this.getRole(roleId))!;
  }

  async replaceRole(
    roleId: string,
    expectedRevision: number,
    input: unknown,
    actorUserId: string,
    requestId: string
  ): Promise<RoleSummary> {
    const parsed = replaceRoleInputSchema.parse(input);
    const existing = await this.getRole(roleId);
    if (!existing) throw new AuthorizationError(404, "role_not_found");
    if (existing.isSystem) throw new RbacConflictError("Built-in roles cannot be edited");
    if (existing.revision !== expectedRevision) {
      throw new RbacConflictError("Role revision conflict");
    }

    try {
      await this.store.replaceRole({
        roleId,
        expectedRevision,
        name: parsed.name,
        normalizedName: normalizeRoleName(parsed.name),
        description: parsed.description ?? null,
        permissions: parsed.permissions,
        actorUserId,
        requestId,
        now: Date.now(),
      });
    } catch (cause) {
      await this.rethrowMutationFailure(
        cause,
        actorUserId,
        ["workspace.roles.manage"],
        async () => {
          const current = await this.getRole(roleId);
          return !current || current.isSystem || current.revision !== expectedRevision;
        }
      );
    }
    return (await this.getRole(roleId))!;
  }

  async deleteRole(roleId: string, actorUserId: string, requestId: string): Promise<void> {
    const existing = await this.getRole(roleId);
    if (!existing || existing.isSystem || existing.assignmentCount > 0) {
      throw new RbacConflictError("Role is built-in, assigned, or missing");
    }
    try {
      await this.store.deleteRole({ roleId, actorUserId, requestId, now: Date.now() });
    } catch (cause) {
      await this.rethrowMutationFailure(
        cause,
        actorUserId,
        ["workspace.roles.manage"],
        async () => {
          const current = await this.getRole(roleId);
          return !current || current.isSystem || current.assignmentCount > 0;
        }
      );
    }
  }

  async listMembers(): Promise<WorkspaceMember[]> {
    return this.store.listMembers();
  }

  async replaceMemberRole(input: {
    targetUserId: string;
    roleId: string;
    actorUserId: string;
    requestId: string;
  }): Promise<void> {
    const [target, role] = await Promise.all([
      this.getEffectiveAuthorization(input.targetUserId),
      this.getRole(input.roleId),
    ]);
    if (!role) throw new AuthorizationError(404, "role_not_found");
    const ownerSensitive = target.role?.key === "owner" || role.key === "owner";
    if (ownerSensitive) {
      await this.requirePermission(input.actorUserId, "workspace.transfer_ownership");
    }
    try {
      await this.store.replaceMemberRole({
        targetUserId: input.targetUserId,
        roleId: input.roleId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        now: Date.now(),
      });
    } catch (cause) {
      await this.rethrowMutationFailure(
        cause,
        input.actorUserId,
        ownerSensitive
          ? ["workspace.members.manage", "workspace.transfer_ownership"]
          : ["workspace.members.manage"],
        async () => {
          const [currentTarget, currentRole] = await Promise.all([
            this.getEffectiveAuthorization(input.targetUserId),
            this.getRole(input.roleId),
          ]);
          return (
            !currentRole ||
            (!ownerSensitive &&
              (currentTarget.role?.key === "owner" || currentRole.key === "owner")) ||
            (currentTarget.role?.key === "owner" &&
              currentRole.key !== "owner" &&
              !(await this.store.hasAnotherUnsuspendedOwner(input.targetUserId)))
          );
        }
      );
    }
  }

  async replaceMemberStatus(input: {
    targetUserId: string;
    suspended: boolean;
    actorUserId: string;
    requestId: string;
  }): Promise<void> {
    const target = await this.getEffectiveAuthorization(input.targetUserId);
    const ownerSensitive = target.role?.key === "owner";
    if (ownerSensitive) {
      await this.requirePermission(input.actorUserId, "workspace.transfer_ownership");
    }
    try {
      await this.store.replaceMemberStatus({
        targetUserId: input.targetUserId,
        suspended: input.suspended,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        now: Date.now(),
      });
    } catch (cause) {
      await this.rethrowMutationFailure(
        cause,
        input.actorUserId,
        ownerSensitive
          ? ["workspace.members.manage", "workspace.transfer_ownership"]
          : ["workspace.members.manage"],
        async () => {
          const currentIsOwner =
            (await this.getEffectiveAuthorization(input.targetUserId)).role?.key === "owner";
          return (
            (!ownerSensitive && currentIsOwner) ||
            (input.suspended &&
              currentIsOwner &&
              !(await this.store.hasAnotherUnsuspendedOwner(input.targetUserId)))
          );
        }
      );
    }
  }

  private async loadRolePermissions(
    roleId: string,
    roleKey: BuiltInRoleKey | null
  ): Promise<PermissionId[]> {
    if (roleKey) return permissionsForBuiltInRole(roleKey);
    return (await this.store.getCustomRolePermissions(roleId)).filter(
      isRegisteredPermission
    ) as PermissionId[];
  }

  private async toRoleSummary(role: AuthorizationRoleRecord): Promise<RoleSummary> {
    return {
      ...role,
      permissions: await this.loadRolePermissions(role.id, role.key),
    };
  }

  private async requireAnotherUnsuspendedOwner(excludedUserId: string): Promise<void> {
    if (!(await this.store.hasAnotherUnsuspendedOwner(excludedUserId))) {
      throw new RbacConflictError("At least one unsuspended Owner is required");
    }
  }

  private async rethrowMutationFailure(
    cause: unknown,
    actorUserId: string,
    permissions: PermissionId[],
    expectedConflict?: () => Promise<boolean>
  ): Promise<never> {
    try {
      for (const permission of permissions) {
        await this.requirePermission(actorUserId, permission);
      }
    } catch (actorCause) {
      if (actorCause instanceof AuthorizationError) {
        throw new RbacConflictError("Actor authorization changed");
      }
      throw cause;
    }
    if (expectedConflict && (await expectedConflict())) {
      throw new RbacConflictError("RBAC precondition conflict");
    }
    throw cause;
  }
}
