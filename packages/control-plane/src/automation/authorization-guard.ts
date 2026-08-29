import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";

export type AutomationAuthorizationOperation = "manage" | "trigger";

export function bindAutomationExecutionGuard(db: SqlDatabase, automationId: string): SqlStatement {
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM automations a
         JOIN users u ON u.id = a.user_id
         JOIN user_role_assignments ura ON ura.user_id = u.id
         WHERE a.id = ? AND a.deleted_at IS NULL AND u.access_status = 'active'
           AND EXISTS (
             SELECT 1 FROM role_permissions rp
             WHERE rp.role_id = ura.role_id AND rp.permission_id = 'sessions.create'
           )
           AND (
             NOT EXISTS (SELECT 1 FROM automation_repositories ar WHERE ar.automation_id = a.id)
             OR EXISTS (
               SELECT 1 FROM role_permissions rp
               WHERE rp.role_id = ura.role_id AND rp.permission_id = 'repositories.use'
             )
           )
           AND (
             NOT EXISTS (SELECT 1 FROM automation_environments ae WHERE ae.automation_id = a.id)
             OR EXISTS (
               SELECT 1 FROM role_permissions rp
               WHERE rp.role_id = ura.role_id AND rp.permission_id = 'environments.use'
             )
           )
       ) THEN 1 ELSE abs(-9223372036854775808) END AS execution_authorization_guard`
    )
    .bind(automationId);
}

export async function isAutomationExecutionAuthorized(
  db: SqlDatabase,
  automationId: string
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 AS authorized FROM automations a
       JOIN users u ON u.id = a.user_id
       JOIN user_role_assignments ura ON ura.user_id = u.id
       WHERE a.id = ? AND a.deleted_at IS NULL AND u.access_status = 'active'
         AND EXISTS (
           SELECT 1 FROM role_permissions rp
           WHERE rp.role_id = ura.role_id AND rp.permission_id = 'sessions.create'
         )
         AND (
           NOT EXISTS (SELECT 1 FROM automation_repositories ar WHERE ar.automation_id = a.id)
           OR EXISTS (
             SELECT 1 FROM role_permissions rp
             WHERE rp.role_id = ura.role_id AND rp.permission_id = 'repositories.use'
           )
         )
         AND (
           NOT EXISTS (SELECT 1 FROM automation_environments ae WHERE ae.automation_id = a.id)
           OR EXISTS (
             SELECT 1 FROM role_permissions rp
             WHERE rp.role_id = ura.role_id AND rp.permission_id = 'environments.use'
           )
         )
       LIMIT 1`
    )
    .bind(automationId)
    .first();
  return row !== null;
}

export function bindPermissionSetGuard(
  db: SqlDatabase,
  authorization: EffectiveAuthorization,
  permissions: readonly PermissionId[]
): SqlStatement {
  const permissionGuards = permissions
    .map(
      () =>
        "EXISTS (SELECT 1 FROM role_permissions rp WHERE rp.role_id = ura.role_id AND rp.permission_id = ?)"
    )
    .join(" AND ");
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         WHERE u.id = ? AND u.access_status = 'active' AND u.authorization_version = ?
           AND ${permissionGuards}
       ) THEN 1 ELSE abs(-9223372036854775808) END AS authorization_guard`
    )
    .bind(authorization.userId, authorization.authorizationVersion, ...permissions);
}

export function bindAutomationAuthorizationGuard(
  db: SqlDatabase,
  automationId: string,
  authorization: EffectiveAuthorization,
  operation: AutomationAuthorizationOperation
): SqlStatement {
  const anyPermission = `automations.${operation}.any`;
  const ownPermission = `automations.${operation}.own`;
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN role_permissions rp ON rp.role_id = ura.role_id
         WHERE u.id = ? AND u.access_status = 'active' AND u.authorization_version = ?
           AND (
             rp.permission_id = ?
             OR (rp.permission_id = ? AND EXISTS (
               SELECT 1 FROM automations a WHERE a.id = ? AND a.user_id = u.id
             ))
           )
       ) THEN 1 ELSE abs(-9223372036854775808) END AS authorization_guard`
    )
    .bind(
      authorization.userId,
      authorization.authorizationVersion,
      anyPermission,
      ownPermission,
      automationId
    );
}

export async function isAutomationAuthorizationCurrent(
  db: SqlDatabase,
  automationId: string,
  authorization: EffectiveAuthorization,
  operation: AutomationAuthorizationOperation
): Promise<boolean> {
  const anyPermission = `automations.${operation}.any`;
  const ownPermission = `automations.${operation}.own`;
  const row = await db
    .prepare(
      `SELECT 1 AS authorized FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       JOIN role_permissions rp ON rp.role_id = ura.role_id
       WHERE u.id = ? AND u.access_status = 'active' AND u.authorization_version = ?
         AND (
           rp.permission_id = ?
           OR (rp.permission_id = ? AND EXISTS (
             SELECT 1 FROM automations a WHERE a.id = ? AND a.user_id = u.id
           ))
         )
       LIMIT 1`
    )
    .bind(
      authorization.userId,
      authorization.authorizationVersion,
      anyPermission,
      ownPermission,
      automationId
    )
    .first();
  return row !== null;
}
