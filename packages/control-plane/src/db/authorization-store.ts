import {
  BUILT_IN_ROLE_REGISTRY,
  roleReferenceSchema,
  type BuiltInRoleKey,
  type PermissionId,
  type RoleReference,
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

/** Persistence view of a user's assignment and suspension state before grants are resolved. */
export interface EffectiveAuthorizationRecord {
  userId: string;
  suspendedAt: number | null;
  role: RoleReference | null;
}

/** Persistence view of a role and the number of users currently assigned to it. */
export type AuthorizationRoleRecord = RoleReference & {
  description: string | null;
  assignmentCount: number;
};

interface AuditInput {
  requestId: string;
  actorUserId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  targetUserId?: string | null;
  reasonCode: string;
  noOpReasonCode: string;
  occurredAt: number;
  metadata: (applied: SqlCondition) => SqlCondition;
}

interface SqlCondition {
  sql: string;
  values: unknown[];
}

function userIsOwner(userId: string): SqlCondition {
  return {
    sql: `EXISTS (
      SELECT 1 FROM user_role_assignments assignment
      WHERE assignment.user_id = ? AND assignment.role_id = ?
    )`,
    values: [userId, OWNER_ROLE_ID],
  };
}

function anotherUnsuspendedOwner(targetUserId: string): SqlCondition {
  return {
    sql: `EXISTS (
      SELECT 1 FROM users other_user
      JOIN user_role_assignments other_assignment ON other_assignment.user_id = other_user.id
      WHERE other_assignment.role_id = ? AND other_user.suspended_at IS NULL
        AND other_user.id <> ?
    )`,
    values: [OWNER_ROLE_ID, targetUserId],
  };
}

/** Result of an atomic RBAC mutation after authorization and invariant checks. */
export type AuthorizationMutationOutcome =
  | { status: "applied" }
  | { status: "no_op" }
  | { status: "actor_authorization_changed" }
  | { status: "role_not_found" }
  | { status: "member_not_found" }
  | { status: "conflict" };

type NotFoundStatus = Extract<
  AuthorizationMutationOutcome["status"],
  "role_not_found" | "member_not_found"
>;

function toRoleReference(id: string, key: BuiltInRoleKey | null, name: string): RoleReference {
  return roleReferenceSchema.parse({ id, key, name });
}

function toEffectiveAuthorizationRecord(row: EffectiveRow): EffectiveAuthorizationRecord {
  return {
    userId: row.user_id,
    suspendedAt: row.suspended_at,
    role:
      row.role_id && row.role_name
        ? toRoleReference(row.role_id, row.role_key, row.role_name)
        : null,
  };
}

function toRoleRecord(row: RoleRow): AuthorizationRoleRecord {
  return {
    ...toRoleReference(row.id, row.key, row.name),
    description: row.description,
    assignmentCount: Number(row.assignment_count),
  };
}

function toMember(row: MemberRow): WorkspaceMember {
  return {
    userId: row.user_id,
    displayName: row.display_name,
    email: row.email,
    suspendedAt: row.suspended_at,
    role: toRoleReference(row.role_id, row.role_key, row.role_name),
  };
}

/** Persists RBAC reads and authorization-guarded, audited member mutations. */
export class AuthorizationStore {
  /** Creates a store using the workspace's SQL database. */
  constructor(private readonly db: SqlDatabase) {}

  /** Loads assignment and suspension state without resolving the role's permissions. */
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

  /** Loads raw custom-role grants for policy-layer validation against the registry. */
  async getCustomRolePermissions(roleId: string): Promise<string[]> {
    const result = await this.db
      .prepare(
        "SELECT permission_id FROM role_permissions WHERE role_id = ? ORDER BY permission_id"
      )
      .bind(roleId)
      .all<{ permission_id: string }>();
    return result.results.map((row) => row.permission_id);
  }

  /** Lists built-in and custom roles with current assignment counts. */
  async listRoles(): Promise<AuthorizationRoleRecord[]> {
    const result = await this.db
      .prepare(
        `SELECT r.id, r.key, r.name, r.description,
                COUNT(ura.user_id) AS assignment_count
         FROM roles r
         LEFT JOIN user_role_assignments ura ON ura.role_id = r.id
         GROUP BY r.id
         ORDER BY r.is_system DESC, r.normalized_name ASC`
      )
      .all<RoleRow>();
    return result.results.map(toRoleRecord);
  }

  /** Loads a role and its assignment count, or null when absent. */
  async getRole(roleId: string): Promise<AuthorizationRoleRecord | null> {
    const row = await this.db
      .prepare(
        `SELECT r.id, r.key, r.name, r.description,
                COUNT(ura.user_id) AS assignment_count
         FROM roles r
         LEFT JOIN user_role_assignments ura ON ura.role_id = r.id
         WHERE r.id = ? GROUP BY r.id`
      )
      .bind(roleId)
      .first<RoleRow>();
    return row ? toRoleRecord(row) : null;
  }

  /** Lists users with role assignments; unassigned users are intentionally excluded. */
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

  /** Atomically revalidates the actor, preserves owner invariants, updates the role, and audits. */
  async replaceMemberRole(input: {
    targetUserId: string;
    roleId: string;
    actorUserId: string;
    requestId: string;
    now: number;
  }): Promise<AuthorizationMutationOutcome> {
    const transferGuard = rolePermissionPredicate("workspace.transfer_ownership");
    const targetIsOwner = userIsOwner(input.targetUserId);
    const otherOwnerExists = anotherUnsuspendedOwner(input.targetUserId);
    const stateChanged: SqlCondition = {
      sql: `EXISTS (
        SELECT 1 FROM user_role_assignments
        WHERE user_id = ? AND role_id <> ?
      )`,
      values: [input.targetUserId, input.roleId],
    };
    const mutation = this.mutationConditions(
      input.actorUserId,
      ["workspace.members.manage"],
      {
        sql: `EXISTS (SELECT 1 FROM roles WHERE id = ?)
            AND EXISTS (SELECT 1 FROM user_role_assignments WHERE user_id = ?)
            AND (NOT (${stateChanged.sql}) OR (
              ? = ?
              OR NOT (${targetIsOwner.sql})
              OR (${otherOwnerExists.sql})
            ))`,
        values: [
          input.roleId,
          input.targetUserId,
          ...stateChanged.values,
          input.roleId,
          OWNER_ROLE_ID,
          ...targetIsOwner.values,
          ...otherOwnerExists.values,
        ],
      },
      {
        actor: {
          sql: `NOT (${stateChanged.sql})
            OR (? <> ? AND NOT (${targetIsOwner.sql}))
            OR ${transferGuard.sql}`,
          values: [
            ...stateChanged.values,
            input.roleId,
            OWNER_ROLE_ID,
            ...targetIsOwner.values,
            ...transferGuard.values,
          ],
        },
        notFound: [
          {
            status: "role_not_found",
            condition: {
              sql: "NOT EXISTS (SELECT 1 FROM roles WHERE id = ?)",
              values: [input.roleId],
            },
          },
          {
            status: "member_not_found",
            condition: {
              sql: "NOT EXISTS (SELECT 1 FROM user_role_assignments WHERE user_id = ?)",
              values: [input.targetUserId],
            },
          },
        ],
      },
      stateChanged
    );
    const results = await this.db.batch([
      this.auditStatement(
        {
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          action: "workspace.member_role_updated",
          resourceType: "user",
          resourceId: input.targetUserId,
          targetUserId: input.targetUserId,
          reasonCode: "member_role_updated",
          noOpReasonCode: "member_role_unchanged",
          occurredAt: input.now,
          metadata: (applied) => ({
            sql: `json_object(
              'before', json_object('roleId', (
                SELECT role_id FROM user_role_assignments WHERE user_id = ?
              )),
              'requested', json_object('roleId', ?),
              'after', json_object('roleId', CASE
                WHEN ${applied.sql} THEN ?
                ELSE (SELECT role_id FROM user_role_assignments WHERE user_id = ?)
              END)
            )`,
            values: [
              input.targetUserId,
              input.roleId,
              ...applied.values,
              input.roleId,
              input.targetUserId,
            ],
          }),
        },
        mutation.outcomeExpression,
        mutation.auditId
      ),
      this.db
        .prepare(`UPDATE users SET updated_at = ? WHERE id = ? AND ${mutation.writes.sql}`)
        .bind(input.now, input.targetUserId, ...mutation.writes.values),
      this.db
        .prepare(
          `UPDATE user_role_assignments SET role_id = ?
           WHERE user_id = ? AND ${mutation.writes.sql}`
        )
        .bind(input.roleId, input.targetUserId, ...mutation.writes.values),
    ]);
    return this.readMutationOutcome(results[0]);
  }

  /** Atomically revalidates the actor, preserves owner invariants, changes status, and audits. */
  async replaceMemberStatus(input: {
    targetUserId: string;
    suspended: boolean;
    actorUserId: string;
    requestId: string;
    now: number;
  }): Promise<AuthorizationMutationOutcome> {
    const transferGuard = rolePermissionPredicate("workspace.transfer_ownership");
    const targetIsOwner = userIsOwner(input.targetUserId);
    const otherOwnerExists = anotherUnsuspendedOwner(input.targetUserId);
    const stateChanged: SqlCondition = {
      sql: `EXISTS (
        SELECT 1 FROM users WHERE id = ?
          AND ((? = 1 AND suspended_at IS NULL) OR (? = 0 AND suspended_at IS NOT NULL))
      )`,
      values: [input.targetUserId, input.suspended ? 1 : 0, input.suspended ? 1 : 0],
    };
    const mutation = this.mutationConditions(
      input.actorUserId,
      ["workspace.members.manage"],
      {
        sql: `EXISTS (
            SELECT 1 FROM users
            JOIN user_role_assignments ON user_role_assignments.user_id = users.id
            WHERE users.id = ?
          )
          AND (NOT (${stateChanged.sql}) OR (
            ? = 0
            OR NOT (${targetIsOwner.sql})
            OR (${otherOwnerExists.sql})
          ))`,
        values: [
          input.targetUserId,
          ...stateChanged.values,
          input.suspended ? 1 : 0,
          ...targetIsOwner.values,
          ...otherOwnerExists.values,
        ],
      },
      {
        actor: {
          sql: `NOT (${stateChanged.sql}) OR NOT (${targetIsOwner.sql}) OR ${transferGuard.sql}`,
          values: [...stateChanged.values, ...targetIsOwner.values, ...transferGuard.values],
        },
        notFound: [
          {
            status: "member_not_found",
            condition: {
              sql: `NOT EXISTS (
                SELECT 1 FROM users
                JOIN user_role_assignments ON user_role_assignments.user_id = users.id
                WHERE users.id = ?
              )`,
              values: [input.targetUserId],
            },
          },
        ],
      },
      stateChanged
    );
    const statements: SqlStatement[] = [
      this.auditStatement(
        {
          requestId: input.requestId,
          actorUserId: input.actorUserId,
          action: "workspace.member_status_updated",
          resourceType: "user",
          resourceId: input.targetUserId,
          targetUserId: input.targetUserId,
          reasonCode: "member_status_updated",
          noOpReasonCode: "member_status_unchanged",
          occurredAt: input.now,
          metadata: (applied) => ({
            sql: `json_object(
              'before', json_object(
                'suspended', CASE
                  WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = ?) THEN NULL
                  WHEN (SELECT suspended_at FROM users WHERE id = ?) IS NULL
                  THEN json('false') ELSE json('true') END,
                'suspendedAt', (SELECT suspended_at FROM users WHERE id = ?)
              ),
              'requested', json_object('suspended', json(?)),
              'after', json_object(
                'suspended', CASE WHEN ${applied.sql} THEN json(?) ELSE CASE
                  WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = ?) THEN NULL
                  WHEN (SELECT suspended_at FROM users WHERE id = ?) IS NULL
                  THEN json('false') ELSE json('true') END END,
                'suspendedAt', CASE
                  WHEN ${applied.sql} THEN ?
                  ELSE (SELECT suspended_at FROM users WHERE id = ?)
                END
              )
            )`,
            values: [
              input.targetUserId,
              input.targetUserId,
              input.targetUserId,
              input.suspended ? "true" : "false",
              ...applied.values,
              input.suspended ? "true" : "false",
              input.targetUserId,
              input.targetUserId,
              ...applied.values,
              input.suspended ? input.now : null,
              input.targetUserId,
            ],
          }),
        },
        mutation.outcomeExpression,
        mutation.auditId
      ),
    ];
    if (input.suspended) {
      statements.push(
        this.db
          .prepare(`DELETE FROM auth_sessions WHERE userId = ? AND ${mutation.writes.sql}`)
          .bind(input.targetUserId, ...mutation.writes.values)
      );
    }
    statements.push(
      this.db
        .prepare(
          `UPDATE users SET suspended_at = ?, updated_at = ?
           WHERE id = ? AND ${mutation.writes.sql}`
        )
        .bind(
          input.suspended ? input.now : null,
          input.now,
          input.targetUserId,
          ...mutation.writes.values
        )
    );
    const results = await this.db.batch(statements);
    return this.readMutationOutcome(results[0]);
  }

  private mutationConditions(
    actorUserId: string,
    permissions: PermissionId[],
    resourceCondition: SqlCondition,
    options: {
      actor?: SqlCondition;
      notFound?: Array<{ status: NotFoundStatus; condition: SqlCondition }>;
    },
    stateChanged: SqlCondition
  ): {
    outcomeExpression: SqlCondition;
    writes: SqlCondition;
    auditId: string;
  } {
    const permissionGuards = permissions.map(rolePermissionPredicate);
    const actor: SqlCondition = {
      sql: `EXISTS (
           SELECT 1 FROM users u
           JOIN user_role_assignments ura ON ura.user_id = u.id
           JOIN roles r ON r.id = ura.role_id
           WHERE u.id = ? AND u.suspended_at IS NULL
               AND ${permissionGuards.map((guard) => guard.sql).join(" AND ")}
                ${options.actor ? `AND (${options.actor.sql})` : ""}
         )`,
      values: [
        actorUserId,
        ...permissionGuards.flatMap((guard) => guard.values),
        ...(options.actor?.values ?? []),
      ],
    };
    const auditId = crypto.randomUUID();
    const notFoundCases =
      options.notFound
        ?.map(({ status, condition }) => `WHEN (${condition.sql}) THEN '${status}'`)
        .join("\n             ") ?? "";
    const outcomeExpression: SqlCondition = {
      sql: `CASE
        WHEN NOT (${actor.sql}) THEN 'actor_authorization_changed'
        ${notFoundCases}
        WHEN NOT (${resourceCondition.sql}) THEN 'conflict'
        WHEN NOT (${stateChanged.sql}) THEN 'no_op'
        ELSE 'applied'
      END`,
      values: [
        ...actor.values,
        ...(options.notFound?.flatMap(({ condition }) => condition.values) ?? []),
        ...resourceCondition.values,
        ...stateChanged.values,
      ],
    };
    return {
      outcomeExpression,
      writes: {
        sql: `EXISTS (
          SELECT 1 FROM authorization_audit_events
          WHERE id = ? AND operation_result = 'applied'
        )`,
        values: [auditId],
      },
      auditId,
    };
  }

  private readMutationOutcome(result: { results: unknown[] }): AuthorizationMutationOutcome {
    const status = (result.results[0] as { status?: unknown } | undefined)?.status;
    if (
      status !== "applied" &&
      status !== "no_op" &&
      status !== "actor_authorization_changed" &&
      status !== "role_not_found" &&
      status !== "member_not_found" &&
      status !== "conflict"
    ) {
      throw new Error("Invalid authorization mutation outcome");
    }
    return { status };
  }

  private auditStatement(input: AuditInput, outcome: SqlCondition, auditId: string): SqlStatement {
    const metadata = input.metadata({ sql: "status = 'applied'", values: [] });
    return this.db
      .prepare(
        `WITH decision(status) AS (SELECT ${outcome.sql})
         INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind,
           actor_user_id_snapshot, action, resource_type, resource_id,
            target_user_id_snapshot, reason_code, operation_result, metadata_json)
          SELECT ?, ?, ?, 'user', ?, ?, ?, ?, ?,
            CASE status
              WHEN 'applied' THEN ?
              WHEN 'no_op' THEN ?
              WHEN 'actor_authorization_changed' THEN 'actor_authorization_changed'
              WHEN 'role_not_found' THEN 'role_not_found'
              WHEN 'member_not_found' THEN 'member_not_found'
              ELSE 'owner_conflict'
            END,
            CASE status
              WHEN 'applied' THEN 'applied'
              WHEN 'no_op' THEN 'no_op'
              WHEN 'actor_authorization_changed' THEN 'denied'
              ELSE 'rejected'
            END,
            ${metadata.sql}
           FROM decision
           RETURNING CASE reason_code
             WHEN ? THEN 'applied'
             WHEN ? THEN 'no_op'
             WHEN 'actor_authorization_changed' THEN 'actor_authorization_changed'
             WHEN 'role_not_found' THEN 'role_not_found'
             WHEN 'member_not_found' THEN 'member_not_found'
             ELSE 'conflict'
           END AS status`
      )
      .bind(
        ...outcome.values,
        auditId,
        input.occurredAt,
        input.requestId,
        input.actorUserId,
        input.action,
        input.resourceType,
        input.resourceId ?? null,
        input.targetUserId ?? null,
        input.reasonCode,
        input.noOpReasonCode,
        ...metadata.values,
        input.reasonCode,
        input.noOpReasonCode
      );
  }
}
