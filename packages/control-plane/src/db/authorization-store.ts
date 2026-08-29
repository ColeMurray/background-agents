import type {
  BuiltInRoleKey,
  PermissionId,
  WorkspaceAccessStatus,
  WorkspaceMember,
} from "@open-inspect/shared/rbac";
import { rolePermissionPredicate } from "../authorization/permission-sql";
import type { SqlDatabase, SqlStatement } from "./sql-database";

const ACTOR_GUARD_SQL =
  "EXISTS (SELECT 1 FROM users WHERE id = ? AND last_authorization_mutation_id = ?)";
const OWNER_ROLE_ID = "role_builtin_owner";

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

export interface EffectiveAuthorizationRecord {
  userId: string;
  accessStatus: WorkspaceAccessStatus;
  authorizationVersion: number;
  role: { id: string; key: BuiltInRoleKey | null; name: string } | null;
}

export interface AuthorizationRoleRecord {
  id: string;
  key: BuiltInRoleKey | null;
  name: string;
  description: string | null;
  isSystem: boolean;
  revision: number;
  assignmentCount: number;
}

export type ActorMutationOutcome = "succeeded" | "actor_conflict";
export type RoleReplacementOutcome = "succeeded" | "actor_conflict" | "revision_conflict";
export type RoleDeletionOutcome = "succeeded" | "actor_conflict" | "role_conflict";
export type MemberMutationOutcome = "succeeded" | "actor_conflict" | "version_conflict";

interface AuditInput {
  requestId: string;
  actorUserId: string | null;
  authorizationVersion?: number;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  targetUserId?: string | null;
  outcome?: "allowed" | "denied";
  reasonCode: string;
  condition?: { sql: string; values: unknown[] };
}

function toEffectiveAuthorizationRecord(row: EffectiveRow): EffectiveAuthorizationRecord {
  return {
    userId: row.user_id,
    accessStatus: row.access_status,
    authorizationVersion: row.authorization_version,
    role:
      row.role_id && row.role_name
        ? { id: row.role_id, key: row.role_key, name: row.role_name }
        : null,
  };
}

function toRoleRecord(row: RoleRow): AuthorizationRoleRecord {
  return {
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.is_system === 1,
    revision: row.revision,
    assignmentCount: Number(row.assignment_count),
  };
}

function toMember(row: MemberRow): WorkspaceMember {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    avatarUrl: row.avatar_url,
    accessStatus: row.access_status,
    authorizationVersion: row.authorization_version,
    role: { id: row.role_id, key: row.role_key, name: row.role_name },
    createdAt: row.created_at,
  };
}

export class AuthorizationStore {
  constructor(private readonly db: SqlDatabase) {}

  async getEffectiveAuthorization(userId: string): Promise<EffectiveAuthorizationRecord | null> {
    const row = await this.db
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
    return row ? toEffectiveAuthorizationRecord(row) : null;
  }

  async getCustomRolePermissions(roleId: string): Promise<string[]> {
    const result = await this.db
      .prepare(
        "SELECT permission_id FROM role_permissions WHERE role_id = ? ORDER BY permission_id"
      )
      .bind(roleId)
      .all<{ permission_id: string }>();
    return result.results.map((row) => row.permission_id);
  }

  async getBootstrapCandidate(userId: string): Promise<{
    accessStatus: WorkspaceAccessStatus;
    authorizationVersion: number;
    roleKey: BuiltInRoleKey | null;
  } | null> {
    const row = await this.db
      .prepare(
        `SELECT u.access_status, u.authorization_version, r.key AS role_key
         FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN roles r ON r.id = ura.role_id
         WHERE u.id = ?`
      )
      .bind(userId)
      .first<{
        access_status: WorkspaceAccessStatus;
        authorization_version: number;
        role_key: BuiltInRoleKey | null;
      }>();
    return row
      ? {
          accessStatus: row.access_status,
          authorizationVersion: row.authorization_version,
          roleKey: row.role_key,
        }
      : null;
  }

  async tryBootstrapOwner(input: {
    userId: string;
    provider: "github" | "google";
    providerUserId: string;
    verifiedEmail: string;
    configuredEmail: string;
    evidenceObservedAt: number;
    requestId: string;
    authorizationVersion: number;
    now: number;
  }): Promise<boolean> {
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
          input.now,
          input.userId,
          input.verifiedEmail,
          input.configuredEmail,
          input.userId,
          input.provider,
          input.providerUserId,
          input.verifiedEmail,
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
        .bind(OWNER_ROLE_ID, input.userId, input.now, input.userId, input.userId, input.userId),
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
        .bind(input.now, input.userId, input.userId),
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
          input.now,
          input.requestId,
          input.userId,
          input.authorizationVersion,
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
        .bind(input.now, input.userId, input.userId),
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

  async listRoles(): Promise<AuthorizationRoleRecord[]> {
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
    return result.results.map(toRoleRecord);
  }

  async getRole(roleId: string): Promise<AuthorizationRoleRecord | null> {
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
    return row ? toRoleRecord(row) : null;
  }

  async createRole(input: {
    roleId: string;
    name: string;
    normalizedName: string;
    description: string | null;
    permissions: PermissionId[];
    actorUserId: string;
    actorAuthorizationVersion: number;
    actorMutationId: string;
    requestId: string;
    now: number;
  }): Promise<ActorMutationOutcome> {
    const results = await this.db.batch([
      this.actorGuardStatement(
        input.actorUserId,
        input.actorAuthorizationVersion,
        "workspace.roles.manage",
        input.actorMutationId
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
          input.roleId,
          input.name,
          input.normalizedName,
          input.description,
          input.actorUserId,
          input.actorUserId,
          input.now,
          input.now,
          input.actorUserId,
          input.actorMutationId
        ),
      ...input.permissions.map((permission) =>
        this.db
          .prepare(
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT ?, ? WHERE EXISTS (SELECT 1 FROM roles WHERE id = ?)`
          )
          .bind(input.roleId, permission, input.roleId)
      ),
      this.auditStatement({
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        authorizationVersion: input.actorAuthorizationVersion,
        action: "workspace.role_created",
        resourceType: "role",
        resourceId: input.roleId,
        reasonCode: "role_created",
        condition: {
          sql: "EXISTS (SELECT 1 FROM roles WHERE id = ?)",
          values: [input.roleId],
        },
      }),
    ]);
    return results[0]?.meta.changes === 1 ? "succeeded" : "actor_conflict";
  }

  async replaceRole(input: {
    roleId: string;
    expectedRevision: number;
    nextRevision: number;
    name: string;
    normalizedName: string;
    description: string | null;
    permissions: PermissionId[];
    actorUserId: string;
    actorAuthorizationVersion: number;
    actorMutationId: string;
    mutationId: string;
    requestId: string;
    now: number;
  }): Promise<RoleReplacementOutcome> {
    const guard = `EXISTS (SELECT 1 FROM roles WHERE id = ? AND revision = ? AND is_system = 0)
      AND ${ACTOR_GUARD_SQL}`;
    const statements: SqlStatement[] = [
      this.actorGuardStatement(
        input.actorUserId,
        input.actorAuthorizationVersion,
        "workspace.roles.manage",
        input.actorMutationId
      ),
      this.db
        .prepare(`DELETE FROM role_permissions WHERE role_id = ? AND ${guard}`)
        .bind(
          input.roleId,
          input.roleId,
          input.expectedRevision,
          input.actorUserId,
          input.actorMutationId
        ),
      ...input.permissions.map((permission) =>
        this.db
          .prepare(
            `INSERT INTO role_permissions (role_id, permission_id)
             SELECT ?, ? WHERE ${guard}`
          )
          .bind(
            input.roleId,
            permission,
            input.roleId,
            input.expectedRevision,
            input.actorUserId,
            input.actorMutationId
          )
      ),
      this.db
        .prepare(
          `UPDATE users SET authorization_version = authorization_version + 1
           WHERE id IN (SELECT user_id FROM user_role_assignments WHERE role_id = ?)
             AND ${guard}`
        )
        .bind(
          input.roleId,
          input.roleId,
          input.expectedRevision,
          input.actorUserId,
          input.actorMutationId
        ),
      this.db
        .prepare(
          `UPDATE roles SET name = ?, normalized_name = ?, description = ?, revision = ?,
             updated_by = ?, updated_at = ?, last_mutation_id = ?
           WHERE id = ? AND revision = ? AND is_system = 0
             AND ${ACTOR_GUARD_SQL}`
        )
        .bind(
          input.name,
          input.normalizedName,
          input.description,
          input.nextRevision,
          input.actorUserId,
          input.now,
          input.mutationId,
          input.roleId,
          input.expectedRevision,
          input.actorUserId,
          input.actorMutationId
        ),
      this.auditStatement({
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        authorizationVersion: input.actorAuthorizationVersion,
        action: "workspace.role_updated",
        resourceType: "role",
        resourceId: input.roleId,
        reasonCode: "role_updated",
        condition: {
          sql: `EXISTS (
            SELECT 1 FROM roles
            WHERE id = ? AND revision = ? AND last_mutation_id = ?
          )`,
          values: [input.roleId, input.nextRevision, input.mutationId],
        },
      }),
    ];
    const results = await this.db.batch(statements);
    if (results[0]?.meta.changes !== 1) return "actor_conflict";
    return results.at(-2)?.meta.changes === 1 ? "succeeded" : "revision_conflict";
  }

  async deleteRole(input: {
    roleId: string;
    actorUserId: string;
    actorAuthorizationVersion: number;
    actorMutationId: string;
    requestId: string;
  }): Promise<RoleDeletionOutcome> {
    const results = await this.db.batch([
      this.actorGuardStatement(
        input.actorUserId,
        input.actorAuthorizationVersion,
        "workspace.roles.manage",
        input.actorMutationId
      ),
      this.auditStatement({
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        authorizationVersion: input.actorAuthorizationVersion,
        action: "workspace.role_deleted",
        resourceType: "role",
        resourceId: input.roleId,
        reasonCode: "role_deleted",
        condition: {
          sql: `EXISTS (
            SELECT 1 FROM roles WHERE id = ? AND is_system = 0
              AND NOT EXISTS (SELECT 1 FROM user_role_assignments WHERE role_id = ?)
          ) AND ${ACTOR_GUARD_SQL}`,
          values: [input.roleId, input.roleId, input.actorUserId, input.actorMutationId],
        },
      }),
      this.db
        .prepare(
          `DELETE FROM roles WHERE id = ? AND is_system = 0
            AND NOT EXISTS (SELECT 1 FROM user_role_assignments WHERE role_id = ?)
            AND ${ACTOR_GUARD_SQL}`
        )
        .bind(input.roleId, input.roleId, input.actorUserId, input.actorMutationId),
    ]);
    if (results[0]?.meta.changes !== 1) return "actor_conflict";
    return results[2]?.meta.changes === 1 ? "succeeded" : "role_conflict";
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
    return result.results.map(toMember);
  }

  async replaceMemberRole(input: {
    targetUserId: string;
    roleId: string;
    expectedVersion: number;
    actorUserId: string;
    actorAuthorizationVersion: number;
    actorMutationId: string;
    mutationId: string;
    bootstrapOwnerEmail: string | null;
    requestId: string;
    now: number;
  }): Promise<MemberMutationOutcome> {
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
      this.actorGuardStatement(
        input.actorUserId,
        input.actorAuthorizationVersion,
        "workspace.members.manage",
        input.actorMutationId
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
          input.now,
          input.targetUserId,
          input.targetUserId,
          input.expectedVersion,
          input.roleId,
          OWNER_ROLE_ID,
          input.targetUserId,
          input.targetUserId,
          input.targetUserId,
          input.bootstrapOwnerEmail,
          input.roleId,
          input.actorUserId,
          input.actorMutationId
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
          input.now,
          input.mutationId,
          input.targetUserId,
          input.expectedVersion,
          input.roleId,
          OWNER_ROLE_ID,
          input.targetUserId,
          input.bootstrapOwnerEmail,
          input.roleId,
          input.actorUserId,
          input.actorMutationId
        ),
      this.auditStatement({
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
          values: [input.targetUserId, input.expectedVersion + 1, input.roleId, input.mutationId],
        },
      }),
    ]);
    if (results[0]?.meta.changes !== 1) return "actor_conflict";
    return results[1]?.meta.changes === 1 && results[2]?.meta.changes === 1
      ? "succeeded"
      : "version_conflict";
  }

  async replaceMemberStatus(input: {
    targetUserId: string;
    accessStatus: WorkspaceAccessStatus;
    expectedVersion: number;
    actorUserId: string;
    actorAuthorizationVersion: number;
    actorMutationId: string;
    mutationId: string;
    bootstrapOwnerEmail: string | null;
    requestId: string;
    now: number;
  }): Promise<MemberMutationOutcome> {
    const results = await this.db.batch([
      this.actorGuardStatement(
        input.actorUserId,
        input.actorAuthorizationVersion,
        "workspace.members.manage",
        input.actorMutationId
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
          input.now,
          input.mutationId,
          input.targetUserId,
          input.expectedVersion,
          input.accessStatus,
          input.accessStatus,
          input.bootstrapOwnerEmail,
          input.bootstrapOwnerEmail,
          input.actorUserId,
          input.actorMutationId
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
          input.mutationId
        ),
      this.auditStatement({
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
          values: [
            input.targetUserId,
            input.expectedVersion + 1,
            input.accessStatus,
            input.mutationId,
          ],
        },
      }),
    ]);
    if (results[0]?.meta.changes !== 1) return "actor_conflict";
    return results[1]?.meta.changes === 1 ? "succeeded" : "version_conflict";
  }

  async hasAnotherActiveOwner(excludedUserId: string): Promise<boolean> {
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
    return Number(row?.count ?? 0) >= 1;
  }

  private actorGuardStatement(
    actorUserId: string,
    actorAuthorizationVersion: number,
    permission: PermissionId,
    mutationId: string
  ): SqlStatement {
    const permissionGuard = rolePermissionPredicate(permission);
    return this.db
      .prepare(
        `UPDATE users SET last_authorization_mutation_id = ?
         WHERE id = ? AND access_status = 'active' AND authorization_version = ?
            AND EXISTS (
              SELECT 1 FROM user_role_assignments ura
              JOIN roles r ON r.id = ura.role_id
              WHERE ura.user_id = users.id AND ${permissionGuard.sql}
            )`
      )
      .bind(mutationId, actorUserId, actorAuthorizationVersion, ...permissionGuard.values);
  }

  private auditStatement(input: AuditInput): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, policy_id, principal_kind,
           actor_user_id_snapshot, authorization_version, action, resource_type, resource_id,
           target_user_id_snapshot, decision_outcome, operation_result, reason_code, metadata_json)
         SELECT ?, ?, ?, ?, 'user', ?, ?, ?, ?, ?, ?, ?, 'succeeded', ?, '{}'
         ${input.condition ? `WHERE ${input.condition.sql}` : ""}`
      )
      .bind(
        crypto.randomUUID(),
        Date.now(),
        input.requestId,
        input.action,
        input.actorUserId,
        input.authorizationVersion ?? null,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.targetUserId ?? null,
        input.outcome ?? "allowed",
        input.reasonCode,
        ...(input.condition?.values ?? [])
      );
  }
}
