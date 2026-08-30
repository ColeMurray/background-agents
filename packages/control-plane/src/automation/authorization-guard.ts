import { type PermissionId } from "@open-inspect/shared/rbac";
import { rolePermissionPredicate } from "../authorization/permission-sql";
import type { SqlDatabase } from "../db/sql-database";

interface SqlPredicate {
  sql: string;
  values: readonly unknown[];
}

function executionPredicate(
  automationId: string,
  requiredAnyOf: readonly PermissionId[] = [],
  executionUserId?: string
): SqlPredicate {
  const createGuard = rolePermissionPredicate("sessions.create");
  const repositoryGuard = rolePermissionPredicate("repositories.use");
  const environmentGuard = rolePermissionPredicate("environments.use");
  const additionalGuards = requiredAnyOf.map(rolePermissionPredicate);
  return {
    sql: `EXISTS (
      SELECT 1 FROM automations a
      JOIN users u ON u.id = ${executionUserId ? "?" : "a.user_id"}
      JOIN user_role_assignments ura ON ura.user_id = u.id
      JOIN roles r ON r.id = ura.role_id
      WHERE a.id = ? AND a.deleted_at IS NULL AND u.suspended_at IS NULL
        AND ${createGuard.sql}
        AND (
          NOT EXISTS (SELECT 1 FROM automation_repositories ar WHERE ar.automation_id = a.id)
          OR ${repositoryGuard.sql}
        )
        AND (
          NOT EXISTS (SELECT 1 FROM automation_environments ae WHERE ae.automation_id = a.id)
          OR ${environmentGuard.sql}
        )
        ${additionalGuards.length > 0 ? `AND (${additionalGuards.map((guard) => guard.sql).join(" OR ")})` : ""}
    )`,
    values: [
      ...(executionUserId ? [executionUserId] : []),
      automationId,
      ...createGuard.values,
      ...repositoryGuard.values,
      ...environmentGuard.values,
      ...additionalGuards.flatMap((guard) => guard.values),
    ],
  };
}

export async function isAutomationExecutionAuthorized(
  db: SqlDatabase,
  automationId: string,
  requiredAnyOf: readonly PermissionId[] = [],
  executionUserId?: string
): Promise<boolean> {
  const predicate = executionPredicate(automationId, requiredAnyOf, executionUserId);
  const row = await db
    .prepare(`SELECT CASE WHEN (${predicate.sql}) THEN 1 ELSE 0 END AS authorized`)
    .bind(...predicate.values)
    .first<{ authorized: number }>();
  return row?.authorized === 1;
}
