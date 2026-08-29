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
  type WorkspaceAccessStatus,
  type WorkspaceMember,
} from "@open-inspect/shared/rbac";
import { AuthorizationStore, type AuthorizationRoleRecord } from "../db/authorization-store";
import { normalizeEmail } from "../db/email";
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
      record.accessStatus === "active"
        ? await this.loadRolePermissions(record.role.id, record.role.key)
        : [];

    return {
      userId: record.userId,
      accessStatus: record.accessStatus,
      role: record.role,
      permissions,
      authorizationVersion: record.authorizationVersion,
    };
  }

  async requirePermission(
    userId: string,
    permission: PermissionId
  ): Promise<EffectiveAuthorization> {
    const authorization = await this.getEffectiveAuthorization(userId);
    if (authorization.accessStatus !== "active") {
      throw new AuthorizationError(403, "active_user_required");
    }
    if (!authorization.permissions.includes(permission)) {
      throw new AuthorizationError(403, "permission_required", permission);
    }
    return authorization;
  }

  async tryBootstrapOwner(input: {
    userId: string;
    provider: "github" | "google";
    providerUserId: string;
    verifiedEmail: string;
    evidenceObservedAt: number;
    configuredEmail: string;
    requestId: string;
  }): Promise<boolean> {
    const configuredEmail = normalizeEmail(input.configuredEmail);
    const verifiedEmail = normalizeEmail(input.verifiedEmail);
    if (!configuredEmail || verifiedEmail !== configuredEmail) return false;

    const candidate = await this.store.getBootstrapCandidate(input.userId);
    if (!candidate || candidate.accessStatus !== "active" || candidate.roleKey === "owner") {
      return false;
    }

    return this.store.tryBootstrapOwner({
      userId: input.userId,
      provider: input.provider,
      providerUserId: input.providerUserId,
      verifiedEmail,
      configuredEmail,
      evidenceObservedAt: input.evidenceObservedAt,
      requestId: input.requestId,
      authorizationVersion: candidate.authorizationVersion,
      now: Date.now(),
    });
  }

  async listRoles(): Promise<RoleSummary[]> {
    const roles = await this.store.listRoles();
    return Promise.all(roles.map((role) => this.toRoleSummary(role)));
  }

  async getRole(roleId: string): Promise<RoleSummary | null> {
    const role = await this.store.getRole(roleId);
    return role ? this.toRoleSummary(role) : null;
  }

  async createRole(
    input: unknown,
    actorUserId: string,
    actorAuthorizationVersion: number,
    requestId: string
  ): Promise<RoleSummary> {
    const parsed = createRoleInputSchema.parse(input);
    const roleId = `role_${crypto.randomUUID()}`;
    const outcome = await this.store.createRole({
      roleId,
      name: parsed.name,
      normalizedName: normalizeRoleName(parsed.name),
      description: parsed.description ?? null,
      permissions: parsed.permissions,
      actorUserId,
      actorAuthorizationVersion,
      actorMutationId: crypto.randomUUID(),
      requestId,
      now: Date.now(),
    });
    if (outcome === "actor_conflict") {
      throw new RbacConflictError("Actor authorization changed");
    }
    return (await this.getRole(roleId))!;
  }

  async replaceRole(
    roleId: string,
    expectedRevision: number,
    input: unknown,
    actorUserId: string,
    actorAuthorizationVersion: number,
    requestId: string
  ): Promise<RoleSummary> {
    const parsed = replaceRoleInputSchema.parse(input);
    const existing = await this.getRole(roleId);
    if (!existing) throw new AuthorizationError(404, "role_not_found");
    if (existing.isSystem) throw new RbacConflictError("Built-in roles cannot be edited");
    if (existing.revision !== expectedRevision) {
      throw new RbacConflictError("Role revision conflict");
    }

    const outcome = await this.store.replaceRole({
      roleId,
      expectedRevision,
      nextRevision: expectedRevision + 1,
      name: parsed.name,
      normalizedName: normalizeRoleName(parsed.name),
      description: parsed.description ?? null,
      permissions: parsed.permissions,
      actorUserId,
      actorAuthorizationVersion,
      actorMutationId: crypto.randomUUID(),
      mutationId: crypto.randomUUID(),
      requestId,
      now: Date.now(),
    });
    if (outcome === "actor_conflict") {
      throw new RbacConflictError("Actor authorization changed");
    }
    if (outcome === "revision_conflict") {
      throw new RbacConflictError("Role revision conflict");
    }
    return (await this.getRole(roleId))!;
  }

  async deleteRole(
    roleId: string,
    actorUserId: string,
    actorAuthorizationVersion: number,
    requestId: string
  ): Promise<void> {
    const existing = await this.getRole(roleId);
    if (!existing || existing.isSystem || existing.assignmentCount > 0) {
      throw new RbacConflictError("Role is built-in, assigned, or missing");
    }
    const outcome = await this.store.deleteRole({
      roleId,
      actorUserId,
      actorAuthorizationVersion,
      actorMutationId: crypto.randomUUID(),
      requestId,
    });
    if (outcome === "actor_conflict") {
      throw new RbacConflictError("Actor authorization changed");
    }
    if (outcome === "role_conflict") {
      throw new RbacConflictError("Role is built-in, assigned, or missing");
    }
  }

  async listMembers(): Promise<WorkspaceMember[]> {
    return this.store.listMembers();
  }

  async replaceMemberRole(input: {
    targetUserId: string;
    roleId: string;
    expectedVersion: number;
    actorUserId: string;
    actorAuthorizationVersion: number;
    actorCanTransferOwnership: boolean;
    bootstrapOwnerEmail: string | undefined;
    requestId: string;
  }): Promise<void> {
    const [target, role] = await Promise.all([
      this.getEffectiveAuthorization(input.targetUserId),
      this.getRole(input.roleId),
    ]);
    if (!role) throw new AuthorizationError(404, "role_not_found");
    if (target.authorizationVersion !== input.expectedVersion) {
      throw new RbacConflictError("Authorization version conflict");
    }
    const ownerSensitive = target.role?.key === "owner" || role.key === "owner";
    if (ownerSensitive && !input.actorCanTransferOwnership) {
      throw new AuthorizationError(403, "permission_required", "workspace.transfer_ownership");
    }
    if (target.role?.key === "owner" && role.key !== "owner") {
      await this.requireAnotherActiveOwner(input.targetUserId);
    }

    const outcome = await this.store.replaceMemberRole({
      targetUserId: input.targetUserId,
      roleId: input.roleId,
      expectedVersion: input.expectedVersion,
      actorUserId: input.actorUserId,
      actorAuthorizationVersion: input.actorAuthorizationVersion,
      actorMutationId: crypto.randomUUID(),
      mutationId: crypto.randomUUID(),
      bootstrapOwnerEmail: normalizeEmail(input.bootstrapOwnerEmail),
      requestId: input.requestId,
      now: Date.now(),
    });
    if (outcome === "actor_conflict") {
      throw new RbacConflictError("Actor authorization changed");
    }
    if (outcome === "version_conflict") {
      throw new RbacConflictError("Authorization version conflict");
    }
  }

  async replaceMemberStatus(input: {
    targetUserId: string;
    accessStatus: WorkspaceAccessStatus;
    expectedVersion: number;
    actorUserId: string;
    actorAuthorizationVersion: number;
    actorCanTransferOwnership: boolean;
    bootstrapOwnerEmail: string | undefined;
    requestId: string;
  }): Promise<void> {
    const target = await this.getEffectiveAuthorization(input.targetUserId);
    if (target.authorizationVersion !== input.expectedVersion) {
      throw new RbacConflictError("Authorization version conflict");
    }
    if (target.role?.key === "owner" && !input.actorCanTransferOwnership) {
      throw new AuthorizationError(403, "permission_required", "workspace.transfer_ownership");
    }
    if (target.role?.key === "owner" && input.accessStatus === "suspended") {
      await this.requireAnotherActiveOwner(input.targetUserId);
    }

    const outcome = await this.store.replaceMemberStatus({
      targetUserId: input.targetUserId,
      accessStatus: input.accessStatus,
      expectedVersion: input.expectedVersion,
      actorUserId: input.actorUserId,
      actorAuthorizationVersion: input.actorAuthorizationVersion,
      actorMutationId: crypto.randomUUID(),
      mutationId: crypto.randomUUID(),
      bootstrapOwnerEmail: normalizeEmail(input.bootstrapOwnerEmail),
      requestId: input.requestId,
      now: Date.now(),
    });
    if (outcome === "actor_conflict") {
      throw new RbacConflictError("Actor authorization changed");
    }
    if (outcome === "version_conflict") {
      throw new RbacConflictError("Authorization version conflict");
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

  private async requireAnotherActiveOwner(excludedUserId: string): Promise<void> {
    if (!(await this.store.hasAnotherActiveOwner(excludedUserId))) {
      throw new RbacConflictError("At least one active Owner is required");
    }
  }
}
