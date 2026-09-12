import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const PRE_0078_SCHEMA = `CREATE TABLE automation_runs (
  id TEXT PRIMARY KEY,
  automation_id TEXT NOT NULL,
  session_id TEXT,
  status TEXT NOT NULL DEFAULT 'starting',
  skip_reason TEXT,
  failure_reason TEXT,
  scheduled_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  invocation_id TEXT NOT NULL,
  repo_owner TEXT,
  repo_name TEXT,
  repo_id INTEGER,
  base_branch TEXT,
  environment_id TEXT,
  FOREIGN KEY (automation_id) REFERENCES automations(id)
)`;

function migration0078() {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0078"));
  if (!migration) throw new Error("Migration 0078 not found in TEST_MIGRATIONS");
  return migration;
}

beforeEach(async () => {
  await env.DB.exec(
    "DELETE FROM automation_runs; DELETE FROM automation_invocations; DELETE FROM automation_repositories; DELETE FROM automation_environments; DELETE FROM automations; DROP TABLE automation_runs;"
  );
  await env.DB.prepare(PRE_0078_SCHEMA).run();
  await env.DB.prepare(
    `INSERT INTO automations
       (id, name, instructions, trigger_type, schedule_cron, schedule_tz, model,
        enabled, next_run_at, consecutive_failures, created_by, created_at, updated_at)
     VALUES ('auto-1', 'Audit', 'Inspect', 'schedule', '0 9 * * *', 'UTC',
             'anthropic/claude-sonnet-4-6', 1, 2000, 0, 'user-1', 1000, 1000)`
  ).run();
});

describe("migration 0078: automation execution recovery", () => {
  it("backfills only runs with concrete evidence of a possibly live execution", async () => {
    const rows = [
      ["running", "running", null, "session-running"],
      ["legacy-timeout", "failed", "execution_timeout", "session-timeout"],
      ["other-failure", "failed", "sandbox_start_failed", "session-failed"],
      ["completed", "completed", null, "session-completed"],
      ["no-session", "running", null, null],
    ] as const;
    for (const [id, status, failureReason, sessionId] of rows) {
      await env.DB.prepare(
        `INSERT INTO automation_runs
           (id, automation_id, session_id, status, failure_reason, scheduled_at,
            created_at, invocation_id)
         VALUES (?, 'auto-1', ?, ?, ?, 1000, 1000, ?)`
      )
        .bind(id, sessionId, status, failureReason, `inv-${id}`)
        .run();
    }

    await env.DB.batch(migration0078().queries.map((query) => env.DB.prepare(query)));

    const result = await env.DB.prepare(
      `SELECT id, execution_unresolved, execution_recovery_reason
       FROM automation_runs ORDER BY id`
    ).all<{
      id: string;
      execution_unresolved: number;
      execution_recovery_reason: string | null;
    }>();
    expect(result.results).toEqual([
      {
        id: "completed",
        execution_unresolved: 0,
        execution_recovery_reason: null,
      },
      {
        id: "legacy-timeout",
        execution_unresolved: 1,
        execution_recovery_reason: "migration_backfill",
      },
      {
        id: "no-session",
        execution_unresolved: 0,
        execution_recovery_reason: null,
      },
      {
        id: "other-failure",
        execution_unresolved: 0,
        execution_recovery_reason: null,
      },
      {
        id: "running",
        execution_unresolved: 1,
        execution_recovery_reason: "migration_backfill",
      },
    ]);
  });
});
