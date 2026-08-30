import {
  BUILT_IN_ROLE_REGISTRY,
  type BuiltInRoleKey,
  type PermissionId,
  type WorkspaceMember,
} from "@open-inspect/shared/rbac";
import { rolePermissionPredicate } from "../authorization/permission-sql";
import type { SqlDatabase, SqlStatement } from "./sql-database";

const OWNER_ROLE_ID = BUILT_IN_ROLE_REGISTRY.owner.id;

interface EffectiveRow {
  user_id: string;
  suspended_at: number | null;
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
  suspended_at: number | null;
  role_id: string;
  role_key: BuiltInRoleKey | null;
  role_name: string;
}

export interface EffectiveAuthorizationRecord {
  userId: string;
  suspendedAt: number | null;
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

interface AuditInput {
  requestId: string;
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  targetUserId?: string | null;
  reasonCode: string;
  occurredAt: number;
}

function toEffectiveAuthorizationRecord(row: EffectiveRow): EffectiveAuthorizationRecord {
  return {
    userId: row.user_id,
    suspendedAt: row.suspended_at,
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
    suspendedAt: row.suspended_at,
    role: { id: row.role_id, key: row.role_key, name: row.role_name },
  };
}

export class AuthorizationStore {
  constructor(private readonly db: SqlDatabase) {}

  async getEffectiveAuthorization(userId: string): Promise<EffectiveAuthorizationRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT u.id AS user_id, u.suspended_at,
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
    requestId: string;
    now: number;
  }): Promise<void> {
    await this.db.batch([
      this.preconditionStatement(input.actorUserId, ["workspace.roles.manage"]),
      this.db
        .prepare(
          `INSERT INTO roles
            (id, key, name, normalized_name, description, is_system, revision)
           VALUES (?, NULL, ?, ?, ?, 0, 1)`
        )
        .bind(input.roleId, input.name, input.normalizedName, input.description),
      ...input.permissions.map((permission) =>
        this.db
          .prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)")
          .bind(input.roleId, permission)
      ),
      this.auditStatement({
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        action: "workspace.role_created",
        resourceType: "role",
        resourceId: input.roleId,
        reasonCode: "role_created",
        occurredAt: input.now,
      }),
    ]);
  }

  async replaceRole(input: {
    roleId: string;
    expectedRevision: number;
    name: string;
    normalizedName: string;
    description: string | null;
    permissions: PermissionId[];
    actorUserId: string;
    requestId: string;
    now: number;
  }): Promise<void> {
    await this.db.batch([
      this.preconditionStatement(input.actorUserId, ["workspace.roles.manage"], {
        sql: "EXISTS (SELECT 1 FROM roles WHERE id = ? AND revision = ? AND is_system = 0)",
        values: [input.roleId, input.expectedRevision],
      }),
      this.db
        .prepare(
          `UPDATE roles SET name = ?, normalized_name = ?, description = ?,
             revision = revision + 1
           WHERE id = ?`
        )
        .bind(input.name, input.normalizedName, input.description, input.roleId),
      this.db.prepare("DELETE FROM role_permissions WHERE role_id = ?").bind(input.roleId),
      ...input.permissions.map((permission) =>
        this.db
          .prepare("INSERT INTO role_permissions (role_id, permission_id) VALUES (?, ?)")
          .bind(input.roleId, permission)
      ),
      this.auditStatement({
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        action: "workspace.role_updated",
        resourceType: "role",
        resourceId: input.roleId,
        reasonCode: "role_updated",
        occurredAt: input.now,
      }),
    ]);
  }

  async deleteRole(input: {
    roleId: string;
    actorUserId: string;
    requestId: string;
    now: number;
  }): Promise<void> {
    await this.db.batch([
      this.preconditionStatement(input.actorUserId, ["workspace.roles.manage"], {
        sql: `EXISTS (
          SELECT 1 FROM roles WHERE id = ? AND is_system = 0
            AND NOT EXISTS (SELECT 1 FROM user_role_assignments WHERE role_id = ?)
        )`,
        values: [input.roleId, input.roleId],
      }),
      this.db.prepare("DELETE FROM roles WHERE id = ?").bind(input.roleId),
      this.auditStatement({
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        action: "workspace.role_deleted",
        resourceType: "role",
        resourceId: input.roleId,
        reasonCode: "role_deleted",
        occurredAt: input.now,
      }),
    ]);
  }

  async listMembers(): Promise<WorkspaceMember[]> {
    const result = await this.db
      .prepare(
        `SELECT u.id AS user_id, u.display_name, u.email, u.suspended_at,
                r.id AS role_id, r.key AS role_key, r.name AS role_name
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
    actorUserId: string;
    requestId: string;
    now: number;
  }): Promise<void> {
    const transferGuard = rolePermissionPredicate("workspace.transfer_ownership");
    await this.db.batch([
      this.preconditionStatement(
        input.actorUserId,
        ["workspace.members.manage"],
        {
          sql: `EXISTS (SELECT 1 FROM roles WHERE id = ?)
            AND EXISTS (SELECT 1 FROM user_role_assignments WHERE user_id = ?)
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
                WHERE other_role.key = 'owner' AND other_user.suspended_at IS NULL
                  AND other_user.id <> ?
              )
            )`,
          values: [
            input.roleId,
            input.targetUserId,
            input.roleId,
            OWNER_ROLE_ID,
            input.targetUserId,
            input.targetUserId,
          ],
        },
        {
          sql: `(
            NOT EXISTS (SELECT 1 FROM roles WHERE id = ? AND key = 'owner')
            AND NOT EXISTS (
              SELECT 1 FROM user_role_assignments current_assignment
              JOIN roles current_role ON current_role.id = current_assignment.role_id
              WHERE current_assignment.user_id = ? AND current_role.key = 'owner'
            )
          ) OR ${transferGuard.sql}`,
          values: [input.roleId, input.targetUserId, ...transferGuard.values],
        }
      ),
      this.db
        .prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
        .bind(input.roleId, input.targetUserId),
      this.db
        .prepare("UPDATE users SET updated_at = ? WHERE id = ?")
        .bind(input.now, input.targetUserId),
      this.auditStatement({
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        action: "workspace.member_role_updated",
        resourceType: "user",
        resourceId: input.targetUserId,
        targetUserId: input.targetUserId,
        reasonCode: "member_role_updated",
        occurredAt: input.now,
      }),
    ]);
  }

  async replaceMemberStatus(input: {
    targetUserId: string;
    suspended: boolean;
    actorUserId: string;
    requestId: string;
    now: number;
  }): Promise<void> {
    const transferGuard = rolePermissionPredicate("workspace.transfer_ownership");
    const statements: SqlStatement[] = [
      this.preconditionStatement(
        input.actorUserId,
        ["workspace.members.manage"],
        {
          sql: `EXISTS (SELECT 1 FROM users WHERE id = ?)
            AND (
              ? = 0
              OR NOT EXISTS (
                SELECT 1 FROM user_role_assignments current_assignment
                JOIN roles current_role ON current_role.id = current_assignment.role_id
                WHERE current_assignment.user_id = ? AND current_role.key = 'owner'
              )
              OR EXISTS (
                SELECT 1 FROM users other_user
                JOIN user_role_assignments other_assignment ON other_assignment.user_id = other_user.id
                JOIN roles other_role ON other_role.id = other_assignment.role_id
                WHERE other_role.key = 'owner' AND other_user.suspended_at IS NULL
                  AND other_user.id <> ?
              )
            )`,
          values: [
            input.targetUserId,
            input.suspended ? 1 : 0,
            input.targetUserId,
            input.targetUserId,
          ],
        },
        {
          sql: `NOT EXISTS (
            SELECT 1 FROM user_role_assignments target_assignment
            JOIN roles target_role ON target_role.id = target_assignment.role_id
            WHERE target_assignment.user_id = ? AND target_role.key = 'owner'
          ) OR ${transferGuard.sql}`,
          values: [input.targetUserId, ...transferGuard.values],
        }
      ),
      this.db
        .prepare("UPDATE users SET suspended_at = ?, updated_at = ? WHERE id = ?")
        .bind(input.suspended ? input.now : null, input.now, input.targetUserId),
    ];
    if (input.suspended) {
      statements.push(
        this.db.prepare("DELETE FROM auth_sessions WHERE userId = ?").bind(input.targetUserId)
      );
    }
    statements.push(
      this.auditStatement({
        requestId: input.requestId,
        actorUserId: input.actorUserId,
        action: "workspace.member_status_updated",
        resourceType: "user",
        resourceId: input.targetUserId,
        targetUserId: input.targetUserId,
        reasonCode: "member_status_updated",
        occurredAt: input.now,
      })
    );
    await this.db.batch(statements);
  }

  async hasAnotherUnsuspendedOwner(excludedUserId: string): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS count
         FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN roles r ON r.id = ura.role_id
         WHERE r.key = 'owner' AND u.suspended_at IS NULL AND u.id <> ?`
      )
      .bind(excludedUserId)
      .first<{ count: number }>();
    return Number(row?.count ?? 0) >= 1;
  }

  private preconditionStatement(
    actorUserId: string,
    permissions: PermissionId[],
    condition?: { sql: string; values: unknown[] },
    actorCondition?: { sql: string; values: unknown[] }
  ): SqlStatement {
    const permissionGuards = permissions.map(rolePermissionPredicate);
    return this.db
      .prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM users u
           JOIN user_role_assignments ura ON ura.user_id = u.id
           JOIN roles r ON r.id = ura.role_id
           WHERE u.id = ? AND u.suspended_at IS NULL
             AND ${permissionGuards.map((guard) => guard.sql).join(" AND ")}
             ${actorCondition ? `AND (${actorCondition.sql})` : ""}
         ) ${condition ? `AND ${condition.sql}` : ""}
         THEN 1 ELSE abs(-9223372036854775808) END AS authorization_precondition`
      )
      .bind(
        actorUserId,
        ...permissionGuards.flatMap((guard) => guard.values),
        ...(actorCondition?.values ?? []),
        ...(condition?.values ?? [])
      );
  }

  private auditStatement(input: AuditInput): SqlStatement {
    return this.db
      .prepare(
        `INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind,
           actor_user_id_snapshot, action, resource_type, resource_id,
           target_user_id_snapshot, reason_code)
         VALUES (?, ?, ?, 'user', ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        input.occurredAt,
        input.requestId,
        input.actorUserId,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.targetUserId ?? null,
        input.reasonCode
      );
  }
}
