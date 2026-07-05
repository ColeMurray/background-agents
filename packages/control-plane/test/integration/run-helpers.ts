/**
 * Raw-SQL run seeding/reading for integration tests. The store no longer
 * exposes single-run inserts (runs are created only as invocation children),
 * but tests still need to place rows in arbitrary shapes — including the
 * legacy shape (no invocation link) that rollback-window code produces.
 */

import { env } from "cloudflare:test";
import type { AutomationRunRow } from "../../src/db/automation-store";

export function makeRunRow(
  automationId: string,
  overrides?: Partial<AutomationRunRow>
): AutomationRunRow {
  const now = Date.now();
  return {
    id: `run-${Math.random().toString(36).slice(2, 8)}`,
    automation_id: automationId,
    invocation_id: null,
    session_id: null,
    status: "starting",
    skip_reason: null,
    failure_reason: null,
    scheduled_at: now,
    started_at: null,
    completed_at: null,
    created_at: now,
    repo_owner: null,
    repo_name: null,
    repo_id: null,
    base_branch: null,
    ...overrides,
  };
}

export async function seedRun(run: AutomationRunRow): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO automation_runs
     (id, automation_id, invocation_id, session_id, status, skip_reason, failure_reason,
      scheduled_at, started_at, completed_at, created_at, repo_owner, repo_name, repo_id, base_branch)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      run.id,
      run.automation_id,
      run.invocation_id,
      run.session_id,
      run.status,
      run.skip_reason,
      run.failure_reason,
      run.scheduled_at,
      run.started_at,
      run.completed_at,
      run.created_at,
      run.repo_owner,
      run.repo_name,
      run.repo_id,
      run.base_branch
    )
    .run();
}

/** All real run rows for an automation, newest first (raw read, no virtual skips). */
export async function fetchRuns(automationId: string): Promise<AutomationRunRow[]> {
  const result = await env.DB.prepare(
    `SELECT * FROM automation_runs WHERE automation_id = ? ORDER BY created_at DESC`
  )
    .bind(automationId)
    .all<AutomationRunRow>();
  return result.results ?? [];
}
