import { type PermissionId } from "@open-inspect/shared/rbac";
import { rolePermissionPredicate } from "../authorization/permission-sql";
import type { SqlDatabase } from "../db/sql-database";

interface SqlPredicate {
  sql: string;
  values: readonly unknown[];
}

/** Immutable execution requirements derived from the targets selected for one firing. */
export interface AutomationExecutionAuthorizationRequest {
  automationId: string;
  executionUserId?: string;
  requiresRepositoryUse: boolean;
  requiresEnvironmentUse: boolean;
}

function executionPredicate(request: AutomationExecutionAuthorizationRequest): SqlPredicate {
  const createGuard = rolePermissionPredicate("sessions.create");
  const repositoryGuard = rolePermissionPredicate("repositories.use");
  const environmentGuard = rolePermissionPredicate("environments.use");
  return {
    sql: `EXISTS (
      SELECT 1 FROM automations a
      JOIN users u ON u.id = ${request.executionUserId ? "?" : "a.user_id"}
      JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id
      WHERE a.id = ? AND a.deleted_at IS NULL AND u.suspended_at IS NULL
        AND ${createGuard.sql}
        ${request.requiresRepositoryUse ? `AND ${repositoryGuard.sql}` : ""}
        ${request.requiresEnvironmentUse ? `AND ${environmentGuard.sql}` : ""}
    )`,
    values: [
      ...(request.executionUserId ? [request.executionUserId] : []),
      request.automationId,
      ...createGuard.values,
      ...(request.requiresRepositoryUse ? repositoryGuard.values : []),
      ...(request.requiresEnvironmentUse ? environmentGuard.values : []),
    ],
  };
}

function principalPredicate(userId: string, permission: PermissionId): SqlPredicate {
  const permissionGuard = rolePermissionPredicate(permission);
  return {
    sql: `EXISTS (
      SELECT 1 FROM users u
      JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id
      WHERE u.id = ? AND u.suspended_at IS NULL AND ${permissionGuard.sql}
    )`,
    values: [userId, ...permissionGuard.values],
  };
}

/**
 * Revalidates that an automation's execution principal may create its session and use its targets.
 *
 * The caller derives repository/environment requirements from the immutable target selection that
 * will execute, so a concurrent edit to the automation tables cannot weaken this decision. Missing
 * users, roles, automations, or suspended users fail closed.
 *
 * This does not decide whether a caller may manage or manually trigger the automation. The route's
 * ownership-scoped authorization performs that admission before execution begins.
 */
export async function isAutomationExecutionAuthorized(
  db: SqlDatabase,
  request: AutomationExecutionAuthorizationRequest
): Promise<boolean> {
  const predicate = executionPredicate(request);
  const row = await db
    .prepare(`SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS authorized`)
    .bind(...predicate.values)
    .first<{ authorized: number }>();
  return row?.authorized === 1;
}

/** Check one canonical principal for a permission without imposing automation-launch grants. */
export async function isPrincipalAuthorized(
  db: SqlDatabase,
  userId: string,
  permission: PermissionId
): Promise<boolean> {
  const predicate = principalPredicate(userId, permission);
  const row = await db
    .prepare(`SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS authorized`)
    .bind(...predicate.values)
    .first<{ authorized: number }>();
  return row?.authorized === 1;
}
