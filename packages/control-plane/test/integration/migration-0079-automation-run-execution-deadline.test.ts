import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import { AutomationStore } from "../../src/db/automation-store";
import { cleanD1Tables } from "./cleanup";

/** Default deadline the sweep holds a run to when the row carries none of its own. */
const DEFAULT_DEADLINE_MS = 3 * 60 * 60 * 1000;

/**
 * The backfill runs exactly once, against rows that were in flight when the
 * column landed, so nothing else in the suite can exercise it. Without it a
 * pre-existing 'running' row keeps a null deadline and the sweep — which skips
 * nulls — would never reap it.
 */
function backfillStatement(): string {
  const migration = env.TEST_MIGRATIONS.find((m) =>
    m.name.startsWith("0079_automation_run_execution_deadline")
  );
  if (!migration) throw new Error("migration 0079 is missing from TEST_MIGRATIONS");
  const update = migration.queries.find((query) =>
    query.trimStart().toUpperCase().startsWith("UPDATE")
  );
  if (!update) throw new Error("migration 0079 has no backfill statement");
  return update;
}

let nextScheduledAt = 1000;

async function seedPreMigrationRun(
  id: string,
  status: string,
  startedAt: number | null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO automation_invocations (id, automation_id, source, scheduled_at, created_at, updated_at)
     VALUES (?, 'auto-0079', 'schedule', ?, 1000, 1000)`
  )
    .bind(`inv-${id}`, (nextScheduledAt += 1000))
    .run();
  await env.DB.prepare(
    `INSERT INTO automation_runs
       (id, automation_id, invocation_id, session_id, status, scheduled_at, started_at,
        execution_deadline_at, created_at)
     VALUES (?, 'auto-0079', ?, 'sess', ?, 1000, ?, NULL, 1000)`
  )
    .bind(id, `inv-${id}`, status, startedAt)
    .run();
}

describe("migration 0079: automation run execution deadline", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await env.DB.prepare(
      `INSERT INTO automations
         (id, name, instructions, trigger_type, schedule_tz, model, enabled,
          consecutive_failures, created_by, created_at, updated_at)
       VALUES ('auto-0079', 'Audit', 'Inspect', 'schedule', 'UTC', 'test-model', 1, 0, 'user-1', 1000, 1000)`
    ).run();
  });

  it("brings in-flight runs under the sweep without shortening the deadline they launched with", async () => {
    const startedAt = 5_000_000;
    await seedPreMigrationRun("run-inflight", "running", startedAt);

    await env.DB.prepare(backfillStatement()).run();

    const row = await env.DB.prepare(
      `SELECT execution_deadline_at FROM automation_runs WHERE id = 'run-inflight'`
    ).first<{ execution_deadline_at: number }>();
    // Strictly later than the 90 minutes these rows were launched under, so the
    // deploy itself cannot fail work that is still running.
    expect(row!.execution_deadline_at).toBeGreaterThan(startedAt + 90 * 60 * 1000);

    const store = new AutomationStore(env.DB);
    const deadline = row!.execution_deadline_at;
    expect(
      await store.getRunsPastExecutionDeadline(deadline + 1, DEFAULT_DEADLINE_MS, 50)
    ).toHaveLength(1);
    expect(
      await store.getRunsPastExecutionDeadline(deadline, DEFAULT_DEADLINE_MS, 50)
    ).toHaveLength(0);
  });

  it("leaves runs the orphan sweep owns alone", async () => {
    await seedPreMigrationRun("run-starting", "starting", null);
    await seedPreMigrationRun("run-completed", "completed", 5_000_000);

    await env.DB.prepare(backfillStatement()).run();

    const rows = await env.DB.prepare(
      `SELECT id FROM automation_runs WHERE execution_deadline_at IS NOT NULL`
    ).all<{ id: string }>();
    expect(rows.results).toHaveLength(0);
  });
});
