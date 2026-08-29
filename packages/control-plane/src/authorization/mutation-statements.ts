import type { PermissionId } from "@open-inspect/shared/rbac";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";
import { rolePermissionPredicate } from "./permission-sql";

export const ACTOR_GUARD_SQL =
  "EXISTS (SELECT 1 FROM users WHERE id = ? AND last_authorization_mutation_id = ?)";

export function actorGuardStatement(
  db: SqlDatabase,
  actorUserId: string,
  actorAuthorizationVersion: number,
  permission: PermissionId,
  mutationId: string
): SqlStatement {
  const permissionGuard = rolePermissionPredicate(permission);
  return db
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

export function auditStatement(
  db: SqlDatabase,
  input: {
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
): SqlStatement {
  return db
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
