import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

const PRE_0059_SCHEMA = [
  `CREATE TABLE automation_runs (
     id              TEXT    PRIMARY KEY,
     automation_id   TEXT    NOT NULL,
     session_id      TEXT,
     status          TEXT    NOT NULL DEFAULT 'starting',
     skip_reason     TEXT,
     failure_reason  TEXT,
     scheduled_at    INTEGER NOT NULL,
     started_at      INTEGER,
     completed_at    INTEGER,
     created_at      INTEGER NOT NULL,
     invocation_id   TEXT,
     repo_owner      TEXT,
     repo_name       TEXT,
     repo_id         INTEGER,
     base_branch     TEXT,
     environment_id  TEXT,
     FOREIGN KEY (automation_id) REFERENCES automations(id)
   )`,
  `CREATE INDEX idx_runs_active_lookup
     ON automation_runs (automation_id, created_at DESC)
     WHERE status IN ('starting', 'running')`,
  `CREATE INDEX idx_runs_automation_created
     ON automation_runs (automation_id, created_at DESC)`,
  `CREATE INDEX idx_runs_invocation
     ON automation_runs (invocation_id, created_at)`,
  `CREATE UNIQUE INDEX idx_runs_invocation_repo
     ON automation_runs (invocation_id, repo_owner, repo_name)
     WHERE repo_owner IS NOT NULL`,
  `CREATE INDEX idx_runs_orphan_sweep
     ON automation_runs (created_at) WHERE status = 'starting'`,
  `CREATE INDEX idx_runs_session
     ON automation_runs (session_id) WHERE session_id IS NOT NULL`,
  `CREATE INDEX idx_runs_timeout_sweep
     ON automation_runs (started_at) WHERE status = 'running'`,
  `CREATE UNIQUE INDEX idx_runs_invocation_environment
     ON automation_runs (invocation_id, environment_id)
     WHERE environment_id IS NOT NULL`,
];

async function resetToPre0059(): Promise<void> {
  await env.DB.exec(
    "DELETE FROM automation_runs; DELETE FROM automation_invocations; DELETE FROM automation_repositories; DELETE FROM automation_environments; DELETE FROM automations; DROP TABLE IF EXISTS automation_runs_new; DROP TABLE automation_runs;"
  );
  for (const statement of PRE_0059_SCHEMA) {
    await env.DB.prepare(statement).run();
  }
  await env.DB.prepare(
    `INSERT INTO automations
       (id, name, instructions, trigger_type, schedule_cron, schedule_tz, model,
        enabled, next_run_at, consecutive_failures, created_by, created_at, updated_at)
     VALUES ('auto-1', 'Audit', 'Inspect', 'schedule', '0 9 * * *', 'UTC',
             'anthropic/claude-sonnet-4-6', 1, 2000, 0, 'user-1', 1000, 1000)`
  ).run();
}

async function applyMigration0059(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0059"));
  if (!migration) throw new Error("Migration 0059 not found in TEST_MIGRATIONS");
  await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));
}

beforeEach(resetToPre0059);

describe("migration 0059: require automation run invocation", () => {
  it("preserves the complete run row, constraints, and indexes", async () => {
    await env.DB.prepare(
      `INSERT INTO automation_runs
         (id, automation_id, session_id, status, skip_reason, failure_reason,
          scheduled_at, started_at, completed_at, created_at, invocation_id,
          repo_owner, repo_name, repo_id, base_branch, environment_id)
       VALUES ('run-1', 'auto-1', 'session-1', 'failed', 'skip', 'failure',
               1100, 1200, 1300, 1000, 'inv-1', 'acme', 'repo', 42, 'main', 'env-1')`
    ).run();

    await applyMigration0059();

    const row = await env.DB.prepare("SELECT * FROM automation_runs WHERE id = 'run-1'").first();
    expect(row).toEqual({
      id: "run-1",
      automation_id: "auto-1",
      session_id: "session-1",
      status: "failed",
      skip_reason: "skip",
      failure_reason: "failure",
      scheduled_at: 1100,
      started_at: 1200,
      completed_at: 1300,
      created_at: 1000,
      invocation_id: "inv-1",
      repo_owner: "acme",
      repo_name: "repo",
      repo_id: 42,
      base_branch: "main",
      environment_id: "env-1",
    });

    const columns = await env.DB.prepare("PRAGMA table_info(automation_runs)").all<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>();
    expect(columns.results).toHaveLength(16);
    expect(columns.results.find((column) => column.name === "invocation_id")?.notnull).toBe(1);
    expect(columns.results.find((column) => column.name === "status")?.dflt_value).toBe(
      "'starting'"
    );

    const indexes = await env.DB.prepare("PRAGMA index_list(automation_runs)").all<{
      name: string;
    }>();
    expect(indexes.results.map((index) => index.name).sort()).toEqual([
      "idx_runs_active_lookup",
      "idx_runs_automation_created",
      "idx_runs_invocation",
      "idx_runs_invocation_environment",
      "idx_runs_invocation_repo",
      "idx_runs_orphan_sweep",
      "idx_runs_session",
      "idx_runs_timeout_sweep",
      "sqlite_autoindex_automation_runs_1",
    ]);

    const foreignKeys = await env.DB.prepare("PRAGMA foreign_key_list(automation_runs)").all<{
      table: string;
      from: string;
      to: string;
    }>();
    expect(foreignKeys.results).toEqual([
      expect.objectContaining({ table: "automations", from: "automation_id", to: "id" }),
    ]);
  });

  it("aborts without dropping malformed rows whose invocation_id is NULL", async () => {
    await env.DB.prepare(
      `INSERT INTO automation_runs
         (id, automation_id, status, scheduled_at, created_at, invocation_id)
       VALUES ('run-malformed', 'auto-1', 'starting', 1100, 1000, NULL)`
    ).run();

    await expect(applyMigration0059()).rejects.toThrow(/NOT NULL constraint failed/);

    expect(await env.DB.prepare("SELECT id, invocation_id FROM automation_runs").first()).toEqual({
      id: "run-malformed",
      invocation_id: null,
    });
    const columns = await env.DB.prepare("PRAGMA table_info(automation_runs)").all<{
      name: string;
      notnull: number;
    }>();
    expect(columns.results.find((column) => column.name === "invocation_id")?.notnull).toBe(0);
    expect(
      await env.DB.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'automation_runs_new'"
      ).first()
    ).toBeNull();
  });
});
