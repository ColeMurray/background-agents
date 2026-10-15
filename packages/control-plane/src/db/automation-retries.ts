import { z } from "zod";
import { AUTOMATION_RETRY_DELAY_MS } from "@open-inspect/shared/types/automations";
import type { SqlStatement, SqlDatabase } from "./sql-database";
import type { AutomationRunRow } from "./automation-store";

export const automationRetryContextSchema = z.object({
  instructions: z.string(),
  platformUserId: z.string(),
  participantUserId: z.string(),
  eventRepositoryId: z.number().optional(),
});

/** Append to the same transaction that records failures, retaining overlap ownership. */
export function bindRetryReservations(
  db: SqlDatabase,
  selector: string,
  params: unknown[]
): SqlStatement[] {
  return [
    db
      .prepare(
        `INSERT INTO automation_runs
      (id, automation_id, invocation_id, status, scheduled_at, created_at, repo_owner,
       repo_name, repo_id, base_branch, environment_id, attempt, retry_at, retry_of_run_id, target_resolved, failure_reason)
      SELECT r.id || ':retry', r.automation_id, r.invocation_id, 'retrying', r.scheduled_at,
        r.completed_at, r.repo_owner, r.repo_name, r.repo_id, r.base_branch, r.environment_id,
        r.attempt + 1, r.completed_at + ? * (1 << (r.attempt - 1)), r.id, r.target_resolved, r.failure_reason
      FROM automation_runs r JOIN automation_invocations i ON i.id = r.invocation_id
      JOIN automations a ON a.id = r.automation_id
      WHERE ${selector} AND r.status = 'failed' AND r.superseded_at IS NULL
        AND r.retry_withdrawn_at IS NULL AND r.retryable = 1
        AND r.completed_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = r.session_id AND s.status = 'cancelled')
        AND i.retry_context IS NOT NULL AND i.failure_counted_at IS NULL
        AND a.enabled = 1 AND a.deleted_at IS NULL AND r.attempt <= a.max_retries
        AND NOT EXISTS (SELECT 1 FROM automation_runs next WHERE next.retry_of_run_id = r.id)`
      )
      .bind(AUTOMATION_RETRY_DELAY_MS, ...params),
    db
      .prepare(
        `UPDATE automation_run_held_prompts SET run_id = (
      SELECT next.id FROM automation_runs next WHERE next.retry_of_run_id = automation_run_held_prompts.run_id)
      WHERE run_id IN (SELECT r.id FROM automation_runs r WHERE ${selector})
        AND EXISTS (SELECT 1 FROM automation_runs next WHERE next.retry_of_run_id = automation_run_held_prompts.run_id)`
      )
      .bind(...params),
    db
      .prepare(
        `UPDATE automation_runs SET superseded_at = completed_at
      WHERE id IN (SELECT r.id FROM automation_runs r WHERE ${selector})
        AND superseded_at IS NULL AND EXISTS (SELECT 1 FROM automation_runs next WHERE next.retry_of_run_id = automation_runs.id)`
      )
      .bind(...params),
  ];
}

/** The policy used for withdrawal, due reads, and claims, evaluated against current rows. */
const RETRY_ELIGIBILITY_SQL = `
  EXISTS (SELECT 1 FROM automations a WHERE a.id = automation_runs.automation_id
    AND a.enabled = 1 AND a.deleted_at IS NULL AND automation_runs.attempt <= a.max_retries + 1)
  AND NOT EXISTS (SELECT 1 FROM sessions s JOIN automation_runs previous ON previous.session_id = s.id
    WHERE previous.id = automation_runs.retry_of_run_id AND s.status = 'cancelled')`;

export function bindWithdrawIneligibleRetries(
  db: SqlDatabase,
  now: number,
  automationId?: string
): SqlStatement {
  return db
    .prepare(
      `UPDATE automation_runs SET status = 'failed', retry_at = NULL,
      retryable = 0, retry_withdrawn_at = ?, completed_at = ?
    WHERE status = 'retrying' AND NOT (${RETRY_ELIGIBILITY_SQL})
      ${automationId === undefined ? "" : "AND automation_id = ?"}`
    )
    .bind(now, now, ...(automationId === undefined ? [] : [automationId]));
}

/** Durably settle attempts whose policy or session cancellation withdrew permission. */
export async function withdrawIneligibleRetries(db: SqlDatabase, now: number): Promise<void> {
  await bindWithdrawIneligibleRetries(db, now).run();
}

/** Read eligible pending attempts; policy changes are settled by the explicit withdrawal step. */
export async function listDueRetries(
  db: SqlDatabase,
  now: number,
  limit: number
): Promise<AutomationRunRow[]> {
  const result = await db
    .prepare(
      `SELECT * FROM automation_runs
    WHERE status = 'retrying' AND retry_at <= ? AND (${RETRY_ELIGIBILITY_SQL})
    ORDER BY retry_at, id LIMIT ?`
    )
    .bind(now, limit)
    .all<AutomationRunRow>();
  return result.results ?? [];
}

/** Claim the already-reserved attempt against the grants version checked at admission. */
export async function claimRetry(
  db: SqlDatabase,
  run: AutomationRunRow,
  now: number,
  teamGrantsVersion?: { teamId: string; version: number }
): Promise<AutomationRunRow | null> {
  const grants = teamGrantsVersion;
  const result = await db
    .prepare(
      `UPDATE automation_runs SET status = 'starting', retry_at = NULL, created_at = ?, failure_reason = NULL,
      repo_owner = ?, repo_name = ?, repo_id = ?, base_branch = ?, target_resolved = ?
    WHERE id = ? AND status = 'retrying' AND retry_at <= ? AND retry_withdrawn_at IS NULL
      AND (${RETRY_ELIGIBILITY_SQL})
      ${grants ? "AND EXISTS (SELECT 1 FROM teams WHERE id = ? AND grants_version = ?)" : ""}`
    )
    .bind(
      now,
      run.repo_owner,
      run.repo_name,
      run.repo_id,
      run.base_branch,
      run.target_resolved ?? 1,
      run.id,
      now,
      ...(grants ? [grants.teamId, grants.version] : [])
    )
    .run();
  return result.meta.changes
    ? { ...run, status: "starting", retry_at: null, created_at: now, failure_reason: null }
    : null;
}
