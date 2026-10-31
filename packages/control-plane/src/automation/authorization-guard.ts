import type { PermissionId } from "@open-inspect/shared/rbac";
import { rolePermissionPredicate } from "../authorization/permission-sql";
import type { SqlDatabase } from "../db/sql-database";

export interface SqlPredicate {
  sql: string;
  values: readonly unknown[];
}

/** `stored` derives the requirement from the automation's target rows when evaluated. */
type TargetUseRequirement = boolean | "stored";

/** Execution requirements, normally derived from the targets selected for one firing. */
export interface AutomationExecutionAuthorizationRequest {
  automationId: string;
  executionUserId?: string;
  requiresRepositoryUse: TargetUseRequirement;
  requiresEnvironmentUse: TargetUseRequirement;
  /**
   * Permissions the admitted request may exercise, such as a personal access token's grant within
   * its owner's role. Each permission execution needs must then be here as well as in the
   * execution user's live role. Absent, the live role alone decides.
   */
  permissionCeiling?: readonly PermissionId[];
}

/** Never satisfied; written as a comparison so it is a boolean in every SQL dialect. */
const NEVER_SQL = "1 = 0";

function storedTargetAbsent(table: "automation_repositories" | "automation_environments"): string {
  return `NOT EXISTS (SELECT 1 FROM ${table} stored_target WHERE stored_target.automation_id = a.id)`;
}

function targetUseGuard(
  requirement: TargetUseRequirement,
  table: "automation_repositories" | "automation_environments",
  permission: "repositories.use" | "environments.use",
  withinCeiling: boolean
): SqlPredicate {
  if (requirement === false) return { sql: "", values: [] };
  // Outside the ceiling no role can supply the permission, so only an absent target passes.
  if (!withinCeiling) {
    return {
      sql: `AND ${requirement === "stored" ? storedTargetAbsent(table) : NEVER_SQL}`,
      values: [],
    };
  }
  const guard = rolePermissionPredicate(permission);
  return {
    sql:
      requirement === "stored"
        ? `AND (${storedTargetAbsent(table)}
             OR ${guard.sql})`
        : `AND ${guard.sql}`,
    values: guard.values,
  };
}

export function automationExecutionPredicate(
  request: AutomationExecutionAuthorizationRequest
): SqlPredicate {
  const ceiling = request.permissionCeiling ? new Set(request.permissionCeiling) : null;
  const withinCeiling = (permission: PermissionId) => !ceiling || ceiling.has(permission);
  const createGuard = withinCeiling("sessions.create")
    ? rolePermissionPredicate("sessions.create")
    : { sql: NEVER_SQL, values: [] };
  const repositoryGuard = targetUseGuard(
    request.requiresRepositoryUse,
    "automation_repositories",
    "repositories.use",
    withinCeiling("repositories.use")
  );
  const environmentGuard = targetUseGuard(
    request.requiresEnvironmentUse,
    "automation_environments",
    "environments.use",
    withinCeiling("environments.use")
  );
  return {
    sql: `EXISTS (
      SELECT 1 FROM automations a
      JOIN users u ON u.id = ${request.executionUserId ? "?" : "a.user_id"}
      JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id
      LEFT JOIN teams t ON t.id = a.owner_team_id
      LEFT JOIN team_memberships tm ON tm.team_id = a.owner_team_id AND tm.user_id = u.id
      WHERE a.id = ? AND a.deleted_at IS NULL AND u.suspended_at IS NULL
        AND (a.owner_team_id IS NULL OR (tm.user_id IS NOT NULL AND t.id IS NOT NULL AND t.archived_at IS NULL))
        AND ${createGuard.sql}
        ${repositoryGuard.sql}
        ${environmentGuard.sql}
    )`,
    values: [
      ...(request.executionUserId ? [request.executionUserId] : []),
      request.automationId,
      ...createGuard.values,
      ...repositoryGuard.values,
      ...environmentGuard.values,
    ],
  };
}

/**
 * Revalidates that an automation's execution principal may create its session and use its targets.
 *
 * The caller derives repository/environment requirements from the immutable target selection that
 * will execute, so a concurrent edit to the automation tables cannot weaken this decision. Missing
 * users, roles, automations, or suspended users fail closed, as does a needed permission outside
 * the request's `permissionCeiling`.
 *
 * This does not decide whether a caller may manage or manually trigger the automation. The route's
 * ownership-scoped authorization performs that admission before execution begins.
 */
export async function isAutomationExecutionAuthorized(
  db: SqlDatabase,
  request: AutomationExecutionAuthorizationRequest
): Promise<boolean> {
  const predicate = automationExecutionPredicate(request);
  const row = await db
    .prepare(`SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS authorized`)
    .bind(...predicate.values)
    .first<{ authorized: number }>();
  return row?.authorized === 1;
}
