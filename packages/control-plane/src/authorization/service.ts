import {
  isRegisteredPermission,
  isCustomRolePermission,
  permissionsForBuiltInRole,
  type BuiltInRoleKey,
  type EffectiveAuthorization,
  type PermissionId,
  type RoleSummary,
  type WorkspaceMember,
} from "@open-inspect/shared/rbac";
import {
  AuthorizationStore,
  type AuthorizationMutationOutcome,
  type AuthorizationRoleRecord,
} from "../db/authorization-store";
import type { SqlDatabase } from "../db/sql-database";

/** Represents an authorization denial that can be translated directly to an API response. */
export class AuthorizationError extends Error {
  /** Creates a denial with its HTTP status, stable error code, and optional missing grant. */
  constructor(
    readonly status: number,
    readonly code: string,
    readonly permission?: PermissionId
  ) {
    super(code);
    this.name = "AuthorizationError";
  }
}

/** Signals that RBAC state changed or violated an invariant during a guarded mutation. */
export class RbacConflictError extends Error {
  /** Creates a conflict suitable for retry or refreshed administrative state. */
  constructor(message: string) {
    super(message);
    this.name = "RbacConflictError";
  }
}

/** Resolves effective grants and coordinates invariant-preserving workspace RBAC mutations. */
export class AuthorizationService {
  private readonly store: AuthorizationStore;

  /** Creates a service backed by the workspace authorization database. */
  constructor(db: SqlDatabase) {
    this.store = new AuthorizationStore(db);
  }

  /** Resolves a user's assigned role and grants, withholding all grants while suspended. */
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

  /** Returns active authorization when the grant is present, or throws a structured denial. */
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

  /** Lists roles with their effective permissions and current assignment counts. */
  async listRoles(): Promise<RoleSummary[]> {
    const roles = await this.store.listRoles();
    return Promise.all(roles.map((role) => this.toRoleSummary(role)));
  }

  /** Returns a role's effective authorization summary, or null when it does not exist. */
  async getRole(roleId: string): Promise<RoleSummary | null> {
    const role = await this.store.getRole(roleId);
    return role ? this.toRoleSummary(role) : null;
  }

  /** Lists assigned workspace members with suspension and role state. */
  async listMembers(): Promise<WorkspaceMember[]> {
    return this.store.listMembers();
  }

  /** Replaces a member's role under actor revalidation and ownership invariants. */
  async replaceMemberRole(input: {
    targetUserId: string;
    roleId: string;
    actorUserId: string;
    requestId: string;
  }): Promise<void> {
    this.requireApplied(
      await this.store.replaceMemberRole({
        targetUserId: input.targetUserId,
        roleId: input.roleId,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        now: Date.now(),
      }),
      "Member role precondition conflict"
    );
  }

  /** Suspends or reactivates a member while preserving an active workspace owner. */
  async replaceMemberStatus(input: {
    targetUserId: string;
    suspended: boolean;
    actorUserId: string;
    requestId: string;
  }): Promise<void> {
    this.requireApplied(
      await this.store.replaceMemberStatus({
        targetUserId: input.targetUserId,
        suspended: input.suspended,
        actorUserId: input.actorUserId,
        requestId: input.requestId,
        now: Date.now(),
      }),
      "Member status precondition conflict"
    );
  }

  private async loadRolePermissions(
    roleId: string,
    roleKey: BuiltInRoleKey | null
  ): Promise<PermissionId[]> {
    if (roleKey) return permissionsForBuiltInRole(roleKey);
    return (await this.store.getCustomRolePermissions(roleId)).filter(
      (permission): permission is PermissionId =>
        isRegisteredPermission(permission) && isCustomRolePermission(permission)
    );
  }

  private async toRoleSummary(role: AuthorizationRoleRecord): Promise<RoleSummary> {
    return {
      ...role,
      permissions: await this.loadRolePermissions(role.id, role.key),
    };
  }

  private requireApplied(outcome: AuthorizationMutationOutcome, conflictMessage: string): void {
    if (outcome.status === "actor_authorization_changed") {
      throw new RbacConflictError("Actor authorization changed");
    }
    if (outcome.status === "role_not_found") {
      throw new AuthorizationError(404, "role_not_found");
    }
    if (outcome.status === "member_not_found") {
      throw new AuthorizationError(404, "member_not_found");
    }
    if (outcome.status === "conflict") {
      throw new RbacConflictError(conflictMessage);
    }
  }
}
