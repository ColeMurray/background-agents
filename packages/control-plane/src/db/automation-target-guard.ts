import type { SqlDatabase, SqlStatement } from "./sql-database";

/** Assert the final cross-table target state inside the mutation's write transaction. */
export function bindAutomationTargetGuard(
  db: SqlDatabase,
  id: string,
  expectedConfig: string | null,
  payloadTarget: boolean
): SqlStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO automation_target_guards (automation_id, consistent)
      SELECT id, CASE WHEN
        (trigger_config = ? OR (trigger_config IS NULL AND ? IS NULL))
        AND (? = 0 OR (
          NOT EXISTS (SELECT 1 FROM automation_repositories WHERE automation_id = a.id)
          AND NOT EXISTS (SELECT 1 FROM automation_environments WHERE automation_id = a.id)
        )) THEN 1 ELSE 0 END
      FROM automations a WHERE id = ?`
      )
      .bind(expectedConfig, expectedConfig, payloadTarget ? 1 : 0, id),
    db.prepare("DELETE FROM automation_target_guards WHERE automation_id = ?").bind(id),
  ];
}

/** The named constraint distinguishes an edit conflict from other database failures. */
export function isAutomationTargetConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("automation_target_consistent") ||
      isAutomationTargetConflict(error.cause))
  );
}
