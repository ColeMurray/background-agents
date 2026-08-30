import type { EffectiveAuthorization, PermissionId } from "@open-inspect/shared/rbac";
import { rolePermissionPredicate } from "../authorization/permission-sql";
import type { SqlDatabase, SqlStatement } from "../db/sql-database";

export type AutomationAuthorizationOperation = "manage" | "trigger";

function executionPredicate(
  automationId: string,
  requiredAnyOf: readonly PermissionId[] = []
): { sql: string; values: string[] } {
  const createGuard = rolePermissionPredicate("sessions.create");
  const repositoryGuard = rolePermissionPredicate("repositories.use");
  const environmentGuard = rolePermissionPredicate("environments.use");
  const additionalGuards = requiredAnyOf.map(rolePermissionPredicate);
  return {
    sql: `a.id = ? AND a.deleted_at IS NULL AND u.access_status = 'active'
      AND ${createGuard.sql}
      AND (
        NOT EXISTS (SELECT 1 FROM automation_repositories ar WHERE ar.automation_id = a.id)
        OR ${repositoryGuard.sql}
      )
      AND (
        NOT EXISTS (SELECT 1 FROM automation_environments ae WHERE ae.automation_id = a.id)
        OR ${environmentGuard.sql}
      )
      ${additionalGuards.length > 0 ? `AND (${additionalGuards.map((guard) => guard.sql).join(" OR ")})` : ""}`,
    values: [
      automationId,
      ...createGuard.values,
      ...repositoryGuard.values,
      ...environmentGuard.values,
      ...additionalGuards.flatMap((guard) => guard.values),
    ],
  };
}

function authPredicate(
  automationId: string,
  authorization: EffectiveAuthorization,
  operation: AutomationAuthorizationOperation,
  requiredPermissions: readonly PermissionId[]
): { sql: string; values: (string | number)[] } {
  const anyGuard = rolePermissionPredicate(`automations.${operation}.any`);
  const ownGuard = rolePermissionPredicate(`automations.${operation}.own`);
  const requiredPermissionGuards = requiredPermissions.map(rolePermissionPredicate);
  return {
    sql: `u.id = ? AND u.access_status = 'active' AND u.authorization_version = ?
      AND (
        ${anyGuard.sql}
        OR (${ownGuard.sql} AND EXISTS (
         SELECT 1 FROM automations a WHERE a.id = ? AND a.user_id = u.id
        ))
      )
      ${requiredPermissionGuards.length > 0 ? `AND ${requiredPermissionGuards.map((guard) => guard.sql).join(" AND ")}` : ""}`,
    values: [
      authorization.userId,
      authorization.authorizationVersion,
      ...anyGuard.values,
      ...ownGuard.values,
      automationId,
      ...requiredPermissionGuards.flatMap((guard) => guard.values),
    ],
  };
}

export function bindAutomationExecutionGuard(db: SqlDatabase, automationId: string): SqlStatement {
  const predicate = executionPredicate(automationId);
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM automations a
         JOIN users u ON u.id = a.user_id
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN roles r ON r.id = ura.role_id
         WHERE ${predicate.sql}
       ) THEN 1 ELSE abs(-9223372036854775808) END AS execution_authorization_guard`
    )
    .bind(...predicate.values);
}

export async function isAutomationExecutionAuthorized(
  db: SqlDatabase,
  automationId: string,
  requiredAnyOf: readonly PermissionId[] = []
): Promise<boolean> {
  const predicate = executionPredicate(automationId, requiredAnyOf);
  const row = await db
    .prepare(
      `SELECT 1 AS authorized FROM automations a
       JOIN users u ON u.id = a.user_id
       JOIN user_role_assignments ura ON ura.user_id = u.id
       JOIN roles r ON r.id = ura.role_id
       WHERE ${predicate.sql}
         LIMIT 1`
    )
    .bind(...predicate.values)
    .first();
  return row !== null;
}

export function bindPermissionSetGuard(
  db: SqlDatabase,
  authorization: EffectiveAuthorization,
  permissions: readonly PermissionId[]
): SqlStatement {
  const permissionGuards = permissions.map(rolePermissionPredicate);
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN roles r ON r.id = ura.role_id
         WHERE u.id = ? AND u.access_status = 'active' AND u.authorization_version = ?
            AND ${permissionGuards.map((guard) => guard.sql).join(" AND ")}
       ) THEN 1 ELSE abs(-9223372036854775808) END AS authorization_guard`
    )
    .bind(
      authorization.userId,
      authorization.authorizationVersion,
      ...permissionGuards.flatMap((guard) => guard.values)
    );
}

export function bindAutomationAuthorizationGuard(
  db: SqlDatabase,
  automationId: string,
  authorization: EffectiveAuthorization,
  operation: AutomationAuthorizationOperation,
  requiredPermissions: readonly PermissionId[] = []
): SqlStatement {
  const predicate = authPredicate(automationId, authorization, operation, requiredPermissions);
  return db
    .prepare(
      `SELECT CASE WHEN EXISTS (
         SELECT 1 FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN roles r ON r.id = ura.role_id
         WHERE ${predicate.sql}
       ) THEN 1 ELSE abs(-9223372036854775808) END AS authorization_guard`
    )
    .bind(...predicate.values);
}

export async function isAutomationAuthorizationCurrent(
  db: SqlDatabase,
  automationId: string,
  authorization: EffectiveAuthorization,
  operation: AutomationAuthorizationOperation,
  requiredPermissions: readonly PermissionId[] = []
): Promise<boolean> {
  const predicate = authPredicate(automationId, authorization, operation, requiredPermissions);
  const row = await db
    .prepare(
      `SELECT 1 AS authorized FROM users u
       JOIN user_role_assignments ura ON ura.user_id = u.id
       JOIN roles r ON r.id = ura.role_id
       WHERE ${predicate.sql}
       LIMIT 1`
    )
    .bind(...predicate.values)
    .first();
  return row !== null;
}
