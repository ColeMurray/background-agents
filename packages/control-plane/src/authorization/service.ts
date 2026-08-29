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
import { normalizeEmail } from "../db/email";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import { ACTOR_GUARD_SQL, actorGuardStatement, auditStatement } from "./mutation-statements";

export const BUILT_IN_ROLE_IDS: Record<BuiltInRoleKey, string> = {
  owner: "role_builtin_owner",
  administrator: "role_builtin_administrator",
  member: "role_builtin_member",
  viewer: "role_builtin_viewer",
};

interface EffectiveRow {
  user_id: string;
  access_status: WorkspaceAccessStatus;
  authorization_version: number;
  role_id: string | null;
  role_key: BuiltInRoleKey | null;
  role_name: string | null;
}

interface RoleRow {
  id: string;
  key: BuiltInRoleKey | null;
  name: string;
  description: string | null;
  is_system: number;
  revision: number;
  assignment_count: number;
}

interface MemberRow {
  user_id: string;
  display_name: string | null;
  email: string | null;
  avatar_url: string | null;
  access_status: WorkspaceAccessStatus;
  authorization_version: number;
  created_at: number;
  role_id: string;
  role_key: BuiltInRoleKey | null;
  role_name: string;
}

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
  constructor(private readonly db: SqlDatabase) {}

  async getEffectiveAuthorization(userId: string): Promise<EffectiveAuthorization> {
    const row = await this.loadEffectiveRow(userId);
    if (!row || row.role_id === null) throw new AuthorizationError(403, "assignment_required");

    const role =
      row.role_id && row.role_name
        ? { id: row.role_id, key: row.role_key, name: row.role_name }
        : null;
    const permissions =
      row.access_status === "active" && role
        ? await this.loadRolePermissions(row.role_id, row.role_key)
        : [];

    return {
      userId: row.user_id,
      accessStatus: row.access_status,
      role,
      permissions,
      authorizationVersion: row.authorization_version,
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
    const user = await this.db
      .prepare(
        `SELECT u.access_status, u.authorization_version, r.key AS role_key
         FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN roles r ON r.id = ura.role_id
         WHERE u.id = ?`
      )
      .bind(input.userId)
      .first<{
        access_status: WorkspaceAccessStatus;
        authorization_version: number;
        role_key: BuiltInRoleKey | null;
      }>();
    if (!user || user.access_status !== "active" || user.role_key === "owner") {
      return false;
    }

    const now = Date.now();
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO workspace_bootstrap
            (singleton, owner_user_id, claimed_at, assignment_completed_at)
           SELECT 1, ?, ?, NULL
            WHERE EXISTS (
              SELECT 1 FROM users u
              JOIN user_role_assignments ura ON ura.user_id = u.id
              JOIN roles r ON r.id = ura.role_id
              WHERE u.id = ? AND u.access_status = 'active'
                AND (r.key IS NULL OR r.key <> 'owner')
            )
              AND ? = ?
              AND EXISTS (
                SELECT 1 FROM browser_sign_in_evidence evidence
                JOIN user_identities identity
                  ON identity.provider = evidence.provider
                 AND identity.provider_user_id = evidence.provider_user_id
                WHERE identity.user_id = ? AND evidence.provider = ?
                  AND evidence.provider_user_id = ? AND evidence.email = ?
                  AND evidence.observed_at = ?
              )
            ON CONFLICT(singleton) DO NOTHING`
        )
        .bind(
          input.userId,
          now,
          input.userId,
          verifiedEmail,
          configuredEmail,
          input.userId,
          input.provider,
          input.providerUserId,
          verifiedEmail,
          input.evidenceObservedAt
        ),
      this.db
        .prepare(
          `UPDATE user_role_assignments
           SET role_id = ?, assigned_by = ?, assigned_at = ?
           WHERE user_id = ?
             AND EXISTS (
               SELECT 1 FROM workspace_bootstrap
               WHERE singleton = 1 AND owner_user_id = ? AND assignment_completed_at IS NULL
             )
             AND EXISTS (SELECT 1 FROM users WHERE id = ? AND access_status = 'active')
             AND EXISTS (
               SELECT 1 FROM roles WHERE id = user_role_assignments.role_id
                 AND (key IS NULL OR key <> 'owner')
             )`
        )
        .bind(BUILT_IN_ROLE_IDS.owner, input.userId, now, input.userId, input.userId, input.userId),
      this.db
        .prepare(
          `UPDATE users SET authorization_version = authorization_version + 1, updated_at = ?
           WHERE id = ?
             AND EXISTS (
             SELECT 1 FROM workspace_bootstrap
             WHERE singleton = 1 AND owner_user_id = ? AND assignment_completed_at IS NULL
             )
             AND access_status = 'active'
             AND EXISTS (
               SELECT 1 FROM user_role_assignments ura
               JOIN roles r ON r.id = ura.role_id
               WHERE ura.user_id = users.id AND r.key = 'owner'
             )`
        )
        .bind(now, input.userId, input.userId),
      this.db
        .prepare(
          `INSERT INTO authorization_audit_events
            (id, occurred_at, request_id, policy_id, principal_kind,
              actor_user_id_snapshot, authorization_version, action, resource_type,
              target_user_id_snapshot,
             decision_outcome, operation_result, reason_code, metadata_json)
            SELECT ?, ?, ?, 'workspace.owner_bootstrapped', 'user', ?, ?,
                  'workspace.owner_bootstrapped', 'workspace', ?, 'allowed', 'succeeded',
                  'configured_owner_email', '{}'
           WHERE EXISTS (
             SELECT 1 FROM workspace_bootstrap
             WHERE singleton = 1 AND owner_user_id = ? AND assignment_completed_at IS NULL
           )
             AND EXISTS (
               SELECT 1 FROM users u
               JOIN user_role_assignments ura ON ura.user_id = u.id
               JOIN roles r ON r.id = ura.role_id
               WHERE u.id = ? AND u.access_status = 'active' AND r.key = 'owner'
           )`
        )
        .bind(
          crypto.randomUUID(),
          now,
          input.requestId,
          input.userId,
          user.authorization_version,
          input.userId,
          input.userId,
          input.userId
        ),
      this.db
        .prepare(
          `UPDATE workspace_bootstrap SET assignment_completed_at = ?
           WHERE singleton = 1 AND owner_user_id = ? AND assignment_completed_at IS NULL
             AND EXISTS (
               SELECT 1 FROM users u
               JOIN user_role_assignments ura ON ura.user_id = u.id
               JOIN roles r ON r.id = ura.role_id
               WHERE u.id = ? AND u.access_status = 'active' AND r.key = 'owner'
             )`
        )
        .bind(now, input.userId, input.userId),
      this.db
        .prepare(
          `SELECT CASE WHEN
             EXISTS (
               SELECT 1 FROM workspace_bootstrap wb
               JOIN users u ON u.id = wb.owner_user_id
               JOIN user_role_assignments ura ON ura.user_id = u.id
               JOIN roles r ON r.id = ura.role_id
               WHERE wb.singleton = 1 AND wb.assignment_completed_at IS NOT NULL
                 AND r.key = 'owner' AND u.access_status = 'active'
             )
             OR NOT EXISTS (
               SELECT 1 FROM workspace_bootstrap
               WHERE singleton = 1 AND owner_user_id = ?
             )
           THEN 1 ELSE abs(-9223372036854775808) END AS bootstrap_guard`
        )
        .bind(input.userId),
    ]);

    return results[4]?.meta.changes === 1;
  }

  async listRoles(): Promise<RoleSummary[]> {
    const result = await this.db
      .prepare(
        `SELECT r.id, r.key, r.name, r.description, r.is_system, r.revision,
                COUNT(ura.user_id) AS assignment_count
         FROM roles r
         LEFT JOIN user_role_assignments ura ON ura.role_id = r.id
         GROUP BY r.id
         ORDER BY r.is_system DESC, r.normalized_name ASC`
      )
      .all<RoleRow>();
    return Promise.all(result.results.map((row) => this.toRoleSummary(row)));
  }

  async getRole(roleId: string): Promise<RoleSummary | null> {
    const row = await this.db
      .prepare(
        `SELECT r.id, r.key, r.name, r.description, r.is_system, r.revision,
                COUNT(ura.user_id) AS assignment_count
         FROM roles r
         LEFT JOIN user_role_assignments ura ON ura.role_id = r.id
         WHERE r.id = ? GROUP BY r.id`
      )
      .bind(roleId)
      .first<RoleRow>();
    return row ? this.toRoleSummary(row) : null;
  }

  async createRole(
    input: unknown,
    actorUserId: string,
    actorAuthorizationVersion: number,
    requestId: string
  ): Promise<RoleSummary> {
    const parsed = createRoleInputSchema.parse(input);
    const roleId = `role_${crypto.randomUUID()}`;
    const actorMutationId = crypto.randomUUID();
    const now = Date.now();
    const results = await this.db.batch([
      actorGuardStatement(
        this.db,
        actorUserId,
        actorAuthorizationVersion,
        "workspace.roles.manage",
        actorMutationId
      ),
      this.db
        .prepare(
          `INSERT INTO roles
            (id, key, name, normalized_name, description, is_system, revision,
              created_by, updated_by, created_at, updated_at)
            SELECT ?, NULL, ?, ?, ?, 0, 1, ?, ?, ?, ?
            WHERE ${ACTOR_GUARD_SQL}`
        )
        .bind(
          roleId,
          parsed.name,
          normalizeRoleName(parsed.name),
          parsed.description ?? null,
          actorUserId,
          actorUserId,
          now,
          now,
          actorUserId,
          actorMutationId
        ),
      ...parsed.permissions.map((permission) =>
        this.db
          .prepare(
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT ?, ? WHERE EXISTS (SELECT 1 FROM roles WHERE id = ?)`
          )
          .bind(roleId, permission, roleId)
      ),
      auditStatement(this.db, {
        requestId,
        actorUserId,
        authorizationVersion: actorAuthorizationVersion,
        action: "workspace.role_created",
        resourceType: "role",
        resourceId: roleId,
        reasonCode: "role_created",
        condition: {
          sql: "EXISTS (SELECT 1 FROM roles WHERE id = ?)",
          values: [roleId],
        },
      }),
    ]);
    if (results[0]?.meta.changes !== 1) {
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
    if (existing.revision !== expectedRevision)
      throw new RbacConflictError("Role revision conflict");

    const now = Date.now();
    const mutationId = crypto.randomUUID();
    const actorMutationId = crypto.randomUUID();
    const nextRevision = expectedRevision + 1;
    const guard = `EXISTS (SELECT 1 FROM roles WHERE id = ? AND revision = ? AND is_system = 0)
      AND ${ACTOR_GUARD_SQL}`;
    const statements: SqlStatement[] = [
      actorGuardStatement(
        this.db,
        actorUserId,
        actorAuthorizationVersion,
        "workspace.roles.manage",
        actorMutationId
      ),
      this.db
        .prepare(`DELETE FROM role_permissions WHERE role_id = ? AND ${guard}`)
        .bind(roleId, roleId, expectedRevision, actorUserId, actorMutationId),
      ...parsed.permissions.map((permission) =>
        this.db
          .prepare(
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT ?, ? WHERE ${guard}`
          )
          .bind(roleId, permission, roleId, expectedRevision, actorUserId, actorMutationId)
      ),
      this.db
        .prepare(
          `UPDATE users SET authorization_version = authorization_version + 1
           WHERE id IN (SELECT user_id FROM user_role_assignments WHERE role_id = ?)
             AND ${guard}`
        )
        .bind(roleId, roleId, expectedRevision, actorUserId, actorMutationId),
      this.db
        .prepare(
          `UPDATE roles SET name = ?, normalized_name = ?, description = ?, revision = ?,
             updated_by = ?, updated_at = ?, last_mutation_id = ?
           WHERE id = ? AND revision = ? AND is_system = 0
             AND ${ACTOR_GUARD_SQL}`
        )
        .bind(
          parsed.name,
          normalizeRoleName(parsed.name),
          parsed.description ?? null,
          nextRevision,
          actorUserId,
          now,
          mutationId,
          roleId,
          expectedRevision,
          actorUserId,
          actorMutationId
        ),
      auditStatement(this.db, {
        requestId,
        actorUserId,
        authorizationVersion: actorAuthorizationVersion,
        action: "workspace.role_updated",
        resourceType: "role",
        resourceId: roleId,
        reasonCode: "role_updated",
        condition: {
          sql: `EXISTS (
            SELECT 1 FROM roles
            WHERE id = ? AND revision = ? AND last_mutation_id = ?
          )`,
          values: [roleId, nextRevision, mutationId],
        },
      }),
    ];
    const results = await this.db.batch(statements);
    if (results[0]?.meta.changes !== 1) {
      throw new RbacConflictError("Actor authorization changed");
    }
    if (results.at(-2)?.meta.changes !== 1) throw new RbacConflictError("Role revision conflict");
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
    const actorMutationId = crypto.randomUUID();
    const results = await this.db.batch([
      actorGuardStatement(
        this.db,
        actorUserId,
        actorAuthorizationVersion,
        "workspace.roles.manage",
        actorMutationId
      ),
      auditStatement(this.db, {
        requestId,
        actorUserId,
        authorizationVersion: actorAuthorizationVersion,
        action: "workspace.role_deleted",
        resourceType: "role",
        resourceId: roleId,
        reasonCode: "role_deleted",
        condition: {
          sql: `EXISTS (
            SELECT 1 FROM roles WHERE id = ? AND is_system = 0
              AND NOT EXISTS (SELECT 1 FROM user_role_assignments WHERE role_id = ?)
          ) AND ${ACTOR_GUARD_SQL}`,
          values: [roleId, roleId, actorUserId, actorMutationId],
        },
      }),
      this.db
        .prepare(
          `DELETE FROM roles WHERE id = ? AND is_system = 0
            AND NOT EXISTS (SELECT 1 FROM user_role_assignments WHERE role_id = ?)
            AND ${ACTOR_GUARD_SQL}`
        )
        .bind(roleId, roleId, actorUserId, actorMutationId),
    ]);
    if (results[0]?.meta.changes !== 1) {
      throw new RbacConflictError("Actor authorization changed");
    }
    if (results[2]?.meta.changes !== 1) {
      throw new RbacConflictError("Role is built-in, assigned, or missing");
    }
  }

  async listMembers(): Promise<WorkspaceMember[]> {
    const result = await this.db
      .prepare(
        `SELECT u.id AS user_id, u.display_name, u.email, u.avatar_url, u.access_status,
                u.authorization_version, u.created_at, r.id AS role_id, r.key AS role_key,
                r.name AS role_name
         FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN roles r ON r.id = ura.role_id
         ORDER BY COALESCE(u.display_name, u.email, u.id) COLLATE NOCASE`
      )
      .all<MemberRow>();
    return result.results.map((row) => ({
      userId: row.user_id,
      displayName: row.display_name,
      email: row.email,
      avatarUrl: row.avatar_url,
      accessStatus: row.access_status,
      authorizationVersion: row.authorization_version,
      role: { id: row.role_id, key: row.role_key, name: row.role_name },
      createdAt: row.created_at,
    }));
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

    const now = Date.now();
    const mutationId = crypto.randomUUID();
    const actorMutationId = crypto.randomUUID();
    const bootstrapOwnerEmail = normalizeEmail(input.bootstrapOwnerEmail);
    const preservesBootstrapEligibility = `(
      EXISTS (SELECT 1 FROM workspace_bootstrap WHERE singleton = 1)
      OR NOT EXISTS (
        SELECT 1 FROM users bootstrap_candidate
        WHERE bootstrap_candidate.id = ? AND lower(trim(bootstrap_candidate.email)) = ?
      )
      OR EXISTS (
        SELECT 1 FROM roles bootstrap_role
        WHERE bootstrap_role.id = ? AND bootstrap_role.key IN ('administrator', 'member')
      )
    )`;
    const results = await this.db.batch([
      actorGuardStatement(
        this.db,
        input.actorUserId,
        input.actorAuthorizationVersion,
        "workspace.members.manage",
        actorMutationId
      ),
      this.db
        .prepare(
          `UPDATE user_role_assignments SET role_id = ?, assigned_by = ?, assigned_at = ?
           WHERE user_id = ?
             AND EXISTS (SELECT 1 FROM users WHERE id = ? AND authorization_version = ?)
             AND (
               ? = ?
               OR NOT EXISTS (
                 SELECT 1 FROM user_role_assignments current_assignment
                 JOIN roles current_role ON current_role.id = current_assignment.role_id
                 WHERE current_assignment.user_id = ? AND current_role.key = 'owner'
               )
               OR EXISTS (
                 SELECT 1 FROM users other_user
                 JOIN user_role_assignments other_assignment ON other_assignment.user_id = other_user.id
                 JOIN roles other_role ON other_role.id = other_assignment.role_id
                 WHERE other_role.key = 'owner' AND other_user.access_status = 'active'
                   AND other_user.id <> ?
               )
              )
              AND ${preservesBootstrapEligibility}
              AND ${ACTOR_GUARD_SQL}`
        )
        .bind(
          input.roleId,
          input.actorUserId,
          now,
          input.targetUserId,
          input.targetUserId,
          input.expectedVersion,
          input.roleId,
          BUILT_IN_ROLE_IDS.owner,
          input.targetUserId,
          input.targetUserId,
          input.targetUserId,
          bootstrapOwnerEmail,
          input.roleId,
          input.actorUserId,
          actorMutationId
        ),
      this.db
        .prepare(
          `UPDATE users SET authorization_version = authorization_version + 1, updated_at = ?,
             last_authorization_mutation_id = ?
           WHERE id = ? AND authorization_version = ?
             AND (
               ? = ?
               OR NOT EXISTS (
                 SELECT 1 FROM user_role_assignments current_assignment
                 JOIN roles current_role ON current_role.id = current_assignment.role_id
                 WHERE current_assignment.user_id = users.id AND current_role.key = 'owner'
               )
               OR EXISTS (
                 SELECT 1 FROM users other_user
                 JOIN user_role_assignments other_assignment ON other_assignment.user_id = other_user.id
                 JOIN roles other_role ON other_role.id = other_assignment.role_id
                 WHERE other_role.key = 'owner' AND other_user.access_status = 'active'
                   AND other_user.id <> users.id
               )
              )
              AND ${preservesBootstrapEligibility}
              AND ${ACTOR_GUARD_SQL}`
        )
        .bind(
          now,
          mutationId,
          input.targetUserId,
          input.expectedVersion,
          input.roleId,
          BUILT_IN_ROLE_IDS.owner,
          input.targetUserId,
          bootstrapOwnerEmail,
          input.roleId,
          input.actorUserId,
          actorMutationId
        ),
      auditStatement(this.db, {
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        authorizationVersion: input.actorAuthorizationVersion,
        action: "workspace.member_role_updated",
        resourceType: "user",
        resourceId: input.targetUserId,
        targetUserId: input.targetUserId,
        reasonCode: "member_role_updated",
        condition: {
          sql: `EXISTS (
            SELECT 1 FROM users u
            JOIN user_role_assignments ura ON ura.user_id = u.id
            WHERE u.id = ? AND u.authorization_version = ? AND ura.role_id = ?
              AND u.last_authorization_mutation_id = ?
          )`,
          values: [input.targetUserId, input.expectedVersion + 1, input.roleId, mutationId],
        },
      }),
    ]);
    if (results[0]?.meta.changes !== 1) {
      throw new RbacConflictError("Actor authorization changed");
    }
    if (results[1]?.meta.changes !== 1 || results[2]?.meta.changes !== 1) {
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
    const now = Date.now();
    const mutationId = crypto.randomUUID();
    const actorMutationId = crypto.randomUUID();
    const bootstrapOwnerEmail = normalizeEmail(input.bootstrapOwnerEmail);
    const results = await this.db.batch([
      actorGuardStatement(
        this.db,
        input.actorUserId,
        input.actorAuthorizationVersion,
        "workspace.members.manage",
        actorMutationId
      ),
      this.db
        .prepare(
          `UPDATE users SET access_status = ?, authorization_version = authorization_version + 1,
             updated_at = ?, last_authorization_mutation_id = ?
             WHERE id = ? AND authorization_version = ?
             AND (
               ? <> 'suspended'
               OR NOT EXISTS (
                 SELECT 1 FROM user_role_assignments current_assignment
                 JOIN roles current_role ON current_role.id = current_assignment.role_id
                 WHERE current_assignment.user_id = users.id AND current_role.key = 'owner'
               )
               OR EXISTS (
                 SELECT 1 FROM users other_user
                 JOIN user_role_assignments other_assignment ON other_assignment.user_id = other_user.id
                 JOIN roles other_role ON other_role.id = other_assignment.role_id
                 WHERE other_role.key = 'owner' AND other_user.access_status = 'active'
                   AND other_user.id <> users.id
               )
              )
              AND (
                ? <> 'suspended'
                OR EXISTS (SELECT 1 FROM workspace_bootstrap WHERE singleton = 1)
                OR ? IS NULL
                OR lower(trim(email)) <> ?
                OR email IS NULL
              )
              AND ${ACTOR_GUARD_SQL}`
        )
        .bind(
          input.accessStatus,
          now,
          mutationId,
          input.targetUserId,
          input.expectedVersion,
          input.accessStatus,
          input.accessStatus,
          bootstrapOwnerEmail,
          bootstrapOwnerEmail,
          input.actorUserId,
          actorMutationId
        ),
      this.db
        .prepare(
          `DELETE FROM auth_sessions WHERE userId = ?
           AND EXISTS (
              SELECT 1 FROM users WHERE id = ? AND access_status = ? AND authorization_version = ?
                AND last_authorization_mutation_id = ?
            )`
        )
        .bind(
          input.targetUserId,
          input.targetUserId,
          input.accessStatus,
          input.expectedVersion + 1,
          mutationId
        ),
      auditStatement(this.db, {
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        authorizationVersion: input.actorAuthorizationVersion,
        action: "workspace.member_status_updated",
        resourceType: "user",
        resourceId: input.targetUserId,
        targetUserId: input.targetUserId,
        reasonCode: "member_status_updated",
        condition: {
          sql: `EXISTS (
            SELECT 1 FROM users
            WHERE id = ? AND authorization_version = ? AND access_status = ?
              AND last_authorization_mutation_id = ?
          )`,
          values: [input.targetUserId, input.expectedVersion + 1, input.accessStatus, mutationId],
        },
      }),
    ]);
    if (results[0]?.meta.changes !== 1) {
      throw new RbacConflictError("Actor authorization changed");
    }
    if (results[1]?.meta.changes !== 1)
      throw new RbacConflictError("Authorization version conflict");
  }

  private async loadEffectiveRow(userId: string): Promise<EffectiveRow | null> {
    return this.db
      .prepare(
        `SELECT u.id AS user_id, u.access_status, u.authorization_version,
                r.id AS role_id, r.key AS role_key, r.name AS role_name
         FROM users u
         LEFT JOIN user_role_assignments ura ON ura.user_id = u.id
         LEFT JOIN roles r ON r.id = ura.role_id
         WHERE u.id = ?`
      )
      .bind(userId)
      .first<EffectiveRow>();
  }

  private async loadRolePermissions(
    roleId: string,
    roleKey: BuiltInRoleKey | null
  ): Promise<PermissionId[]> {
    if (roleKey) return permissionsForBuiltInRole(roleKey);
    const result = await this.db
      .prepare(
        "SELECT permission_id FROM role_permissions WHERE role_id = ? ORDER BY permission_id"
      )
      .bind(roleId)
      .all<{ permission_id: string }>();
    return result.results
      .map((row) => row.permission_id)
      .filter(isRegisteredPermission) as PermissionId[];
  }

  private async toRoleSummary(row: RoleRow): Promise<RoleSummary> {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      description: row.description,
      isSystem: row.is_system === 1,
      revision: row.revision,
      permissions: await this.loadRolePermissions(row.id, row.key),
      assignmentCount: Number(row.assignment_count),
    };
  }

  private async requireAnotherActiveOwner(excludedUserId: string): Promise<void> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN roles r ON r.id = ura.role_id
         WHERE r.key = 'owner' AND u.access_status = 'active' AND u.id <> ?`
      )
      .bind(excludedUserId)
      .first<{ count: number }>();
    if (!row || Number(row.count) < 1)
      throw new RbacConflictError("At least one active Owner is required");
  }
}
