import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type ColumnContract = {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
};

const EXPECTED_COLUMNS: Record<string, ColumnContract[]> = {
  automations: [
    { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "instructions", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "trigger_type", type: "TEXT", notnull: 1, dflt_value: "'schedule'", pk: 0 },
    { name: "schedule_cron", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "schedule_tz", type: "TEXT", notnull: 1, dflt_value: "'UTC'", pk: 0 },
    { name: "model", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "enabled", type: "INTEGER", notnull: 1, dflt_value: "1", pk: 0 },
    { name: "next_run_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "consecutive_failures", type: "INTEGER", notnull: 1, dflt_value: "0", pk: 0 },
    { name: "created_by", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "deleted_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "reasoning_effort", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "event_type", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "trigger_config", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "trigger_auth_data", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "user_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  ],
  automation_runs: [
    { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "automation_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "session_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, dflt_value: "'starting'", pk: 0 },
    { name: "skip_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "failure_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "scheduled_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "started_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "completed_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "invocation_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "repo_owner", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "repo_name", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "repo_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "base_branch", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "environment_id", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
  ],
  automation_invocations: [
    { name: "id", type: "TEXT", notnull: 0, dflt_value: null, pk: 1 },
    { name: "automation_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "source", type: "TEXT", notnull: 1, dflt_value: null, pk: 0 },
    { name: "scheduled_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "trigger_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "concurrency_key", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "trigger_metadata", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "skip_reason", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "failure_counted_at", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  ],
  automation_repositories: [
    { name: "automation_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { name: "repo_owner", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
    { name: "repo_name", type: "TEXT", notnull: 1, dflt_value: null, pk: 3 },
    { name: "repo_id", type: "INTEGER", notnull: 0, dflt_value: null, pk: 0 },
    { name: "base_branch", type: "TEXT", notnull: 0, dflt_value: null, pk: 0 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  ],
  automation_environments: [
    { name: "automation_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 1 },
    { name: "environment_id", type: "TEXT", notnull: 1, dflt_value: null, pk: 2 },
    { name: "created_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
    { name: "updated_at", type: "INTEGER", notnull: 1, dflt_value: null, pk: 0 },
  ],
};

const EXPECTED_INDEXES: Record<string, string[]> = {
  automations: [
    "idx_automations_active_created_id:0:1:created_at:1,id:1",
    "idx_automations_schedule_due:0:1:enabled:0,trigger_type:0,next_run_at:0",
    "idx_automations_sentry_match:0:1:trigger_type:0,event_type:0",
  ],
  automation_runs: [
    "idx_runs_active_lookup:0:1:automation_id:0,created_at:1",
    "idx_runs_automation_created:0:0:automation_id:0,created_at:1",
    "idx_runs_invocation:0:0:invocation_id:0,created_at:0",
    "idx_runs_invocation_environment:1:1:invocation_id:0,environment_id:0",
    "idx_runs_invocation_repo:1:1:invocation_id:0,repo_owner:0,repo_name:0",
    "idx_runs_orphan_sweep:0:1:created_at:0",
    "idx_runs_session:0:1:session_id:0",
    "idx_runs_timeout_sweep:0:1:started_at:0",
  ],
  automation_invocations: [
    "idx_invocations_automation_created:0:0:automation_id:0,created_at:1",
    "idx_invocations_concurrency:0:1:automation_id:0,concurrency_key:0",
    "idx_invocations_created:0:0:created_at:1",
    "idx_invocations_idempotency:1:1:automation_id:0,scheduled_at:0",
    "idx_invocations_trigger_key:1:1:automation_id:0,trigger_key:0",
  ],
  automation_repositories: ["idx_automation_repositories_repo:0:0:repo_owner:0,repo_name:0"],
  automation_environments: ["idx_automation_environments_environment:0:0:environment_id:0"],
};

const EXPECTED_INDEX_PREDICATES: Record<string, string> = {
  idx_automations_active_created_id: "deleted_at IS NULL",
  idx_automations_schedule_due: "enabled = 1 AND deleted_at IS NULL AND trigger_type = 'schedule'",
  idx_automations_sentry_match: "enabled = 1 AND deleted_at IS NULL AND trigger_type = 'sentry'",
  idx_runs_active_lookup: "status IN ('starting', 'running')",
  idx_runs_invocation_environment: "environment_id IS NOT NULL",
  idx_runs_invocation_repo: "repo_owner IS NOT NULL",
  idx_runs_orphan_sweep: "status = 'starting'",
  idx_runs_session: "session_id IS NOT NULL",
  idx_runs_timeout_sweep: "status = 'running'",
  idx_invocations_concurrency: "concurrency_key IS NOT NULL",
  idx_invocations_idempotency: "source = 'schedule'",
  idx_invocations_trigger_key: "trigger_key IS NOT NULL",
};

async function expectCanonicalSchema(): Promise<void> {
  for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
    const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<
      ColumnContract & { cid: number }
    >();
    expect(columns.results.map(({ cid: _cid, ...column }) => column)).toEqual(expectedColumns);

    const indexes = await env.DB.prepare(`PRAGMA index_list(${table})`).all<{
      name: string;
      unique: number;
      partial: number;
      origin: string;
    }>();
    const contracts = await Promise.all(
      indexes.results
        .filter((index) => index.origin === "c")
        .map(async (index) => {
          const keys = await env.DB.prepare(`PRAGMA index_xinfo(${index.name})`).all<{
            name: string;
            desc: number;
            key: number;
          }>();
          const columns = keys.results
            .filter((key) => key.key === 1)
            .map((key) => `${key.name}:${key.desc}`)
            .join(",");
          if (index.partial === 1) {
            const definition = await env.DB.prepare(
              "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?"
            )
              .bind(index.name)
              .first<{ sql: string }>();
            const predicate = definition?.sql
              .match(/\bWHERE\b([\s\S]*)$/i)?.[1]
              .replace(/\s+/g, " ")
              .trim();
            expect(predicate).toBe(EXPECTED_INDEX_PREDICATES[index.name]);
          }
          return `${index.name}:${index.unique}:${index.partial}:${columns}`;
        })
    );
    expect(contracts.sort()).toEqual(EXPECTED_INDEXES[table]);
  }
}

describe("migration 0063: drop automation environment id", () => {
  it("preserves automation data, relationships, constraints, and indexes", async () => {
    // The test setup applies the complete migration history, covering fresh databases.
    await expectCanonicalSchema();

    // Restore the sole pre-0063 difference, then migrate representative existing data.
    await env.DB.prepare("ALTER TABLE automations ADD COLUMN environment_id TEXT").run();
    await env.DB.prepare(
      `INSERT INTO automations
         (id, name, instructions, trigger_type, schedule_cron, schedule_tz, model,
          enabled, next_run_at, consecutive_failures, created_by, created_at, updated_at,
          reasoning_effort, event_type, trigger_config, trigger_auth_data, user_id, environment_id)
       VALUES ('auto-1', 'Audit', 'Inspect', 'schedule', '0 9 * * *', 'UTC',
               'anthropic/claude-sonnet-4-6', 1, 2000, 2, 'creator-1', 1000, 1100,
               'high', 'push', '{"branch":"main"}', 'secret', 'user-1', 'env-stale')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO automation_invocations
         (id, automation_id, source, scheduled_at, trigger_key, concurrency_key,
          trigger_metadata, skip_reason, failure_counted_at, created_at, updated_at)
       VALUES ('inv-1', 'auto-1', 'schedule', 1200, NULL, 'branch:main',
               '{"source":"test"}', NULL, NULL, 1000, 1100)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO automation_runs
         (id, automation_id, session_id, status, skip_reason, failure_reason,
          scheduled_at, started_at, completed_at, created_at, invocation_id,
          repo_owner, repo_name, repo_id, base_branch, environment_id)
       VALUES ('run-1', 'auto-1', 'session-1', 'failed', 'skip', 'failure',
               1200, 1250, 1300, 1000, 'inv-1', 'acme', 'repo', 42, 'main', 'env-1')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO automation_repositories
         (automation_id, repo_owner, repo_name, repo_id, base_branch, created_at, updated_at)
       VALUES ('auto-1', 'acme', 'repo', 42, 'main', 1000, 1100)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO automation_environments
         (automation_id, environment_id, created_at, updated_at)
       VALUES ('auto-1', 'env-1', 1000, 1100)`
    ).run();

    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0063"));
    if (!migration) throw new Error("Migration 0063 not found in TEST_MIGRATIONS");
    await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));

    await expectCanonicalSchema();
    expect(await env.DB.prepare("SELECT * FROM automations").first()).toEqual({
      id: "auto-1",
      name: "Audit",
      instructions: "Inspect",
      trigger_type: "schedule",
      schedule_cron: "0 9 * * *",
      schedule_tz: "UTC",
      model: "anthropic/claude-sonnet-4-6",
      enabled: 1,
      next_run_at: 2000,
      consecutive_failures: 2,
      created_by: "creator-1",
      created_at: 1000,
      updated_at: 1100,
      deleted_at: null,
      reasoning_effort: "high",
      event_type: "push",
      trigger_config: '{"branch":"main"}',
      trigger_auth_data: "secret",
      user_id: "user-1",
    });
    expect(await env.DB.prepare("SELECT * FROM automation_runs").first()).toEqual({
      id: "run-1",
      automation_id: "auto-1",
      session_id: "session-1",
      status: "failed",
      skip_reason: "skip",
      failure_reason: "failure",
      scheduled_at: 1200,
      started_at: 1250,
      completed_at: 1300,
      created_at: 1000,
      invocation_id: "inv-1",
      repo_owner: "acme",
      repo_name: "repo",
      repo_id: 42,
      base_branch: "main",
      environment_id: "env-1",
    });
    expect(await env.DB.prepare("SELECT * FROM automation_invocations").first()).toEqual({
      id: "inv-1",
      automation_id: "auto-1",
      source: "schedule",
      scheduled_at: 1200,
      trigger_key: null,
      concurrency_key: "branch:main",
      trigger_metadata: '{"source":"test"}',
      skip_reason: null,
      failure_counted_at: null,
      created_at: 1000,
      updated_at: 1100,
    });
    expect(await env.DB.prepare("SELECT * FROM automation_repositories").first()).toEqual({
      automation_id: "auto-1",
      repo_owner: "acme",
      repo_name: "repo",
      repo_id: 42,
      base_branch: "main",
      created_at: 1000,
      updated_at: 1100,
    });
    expect(await env.DB.prepare("SELECT * FROM automation_environments").first()).toEqual({
      automation_id: "auto-1",
      environment_id: "env-1",
      created_at: 1000,
      updated_at: 1100,
    });

    for (const table of [
      "automation_runs",
      "automation_invocations",
      "automation_repositories",
      "automation_environments",
    ]) {
      const foreignKeys = await env.DB.prepare(`PRAGMA foreign_key_list(${table})`).all<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string;
        on_update: string;
        on_delete: string;
        match: string;
      }>();
      expect(foreignKeys.results).toEqual([
        {
          id: 0,
          seq: 0,
          table: "automations",
          from: "automation_id",
          to: "id",
          on_update: "NO ACTION",
          on_delete: "NO ACTION",
          match: "NONE",
        },
      ]);
    }

    await expect(
      env.DB.prepare(
        `INSERT INTO automation_invocations
           (id, automation_id, source, created_at, updated_at)
         VALUES ('inv-invalid', 'auto-1', 'schedule', 1400, 1400)`
      ).run()
    ).rejects.toThrow(/CHECK constraint failed/);
  });
});
