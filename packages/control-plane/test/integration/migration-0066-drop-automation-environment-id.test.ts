import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

async function automationColumns(): Promise<string[]> {
  const columns = await env.DB.prepare("PRAGMA table_info(automations)").all<{ name: string }>();
  return columns.results.map((column) => column.name);
}

afterEach(async () => {
  await cleanD1Tables();
  if ((await automationColumns()).includes("environment_id")) {
    await env.DB.prepare("ALTER TABLE automations DROP COLUMN environment_id").run();
  }
});

describe("migration 0066: drop automation environment id", () => {
  it("removes the scalar while preserving automation relationships", async () => {
    // Full-history setup covers fresh databases; restore the sole pre-0066 difference.
    expect(await automationColumns()).not.toContain("environment_id");
    await env.DB.prepare("ALTER TABLE automations ADD COLUMN environment_id TEXT").run();
    await env.DB.prepare(
      `INSERT INTO automations
         (id, name, instructions, trigger_type, schedule_tz, model, enabled,
          consecutive_failures, created_by, created_at, updated_at, environment_id)
       VALUES ('auto-1', 'Audit', 'Inspect', 'schedule', 'UTC', 'test-model', 1,
               0, 'user-1', 1000, 1000, 'env-stale')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO automation_invocations
         (id, automation_id, source, scheduled_at, created_at, updated_at)
       VALUES ('inv-1', 'auto-1', 'schedule', 1000, 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO automation_runs
         (id, automation_id, status, scheduled_at, created_at, invocation_id, environment_id)
       VALUES ('run-1', 'auto-1', 'completed', 1000, 1000, 'inv-1', 'env-1')`
    ).run();
    await env.DB.prepare(
      `INSERT INTO automation_repositories
         (automation_id, repo_owner, repo_name, created_at, updated_at)
       VALUES ('auto-1', 'acme', 'repo', 1000, 1000)`
    ).run();
    await env.DB.prepare(
      `INSERT INTO automation_environments
         (automation_id, environment_id, created_at, updated_at)
       VALUES ('auto-1', 'env-1', 1000, 1000)`
    ).run();

    const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0066"));
    if (!migration) throw new Error("Migration 0066 not found in TEST_MIGRATIONS");
    await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));

    expect(await automationColumns()).not.toContain("environment_id");
    expect(await env.DB.prepare("SELECT id, name, instructions FROM automations").first()).toEqual({
      id: "auto-1",
      name: "Audit",
      instructions: "Inspect",
    });
    expect(
      await env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM automation_invocations) AS invocations,
           (SELECT COUNT(*) FROM automation_runs) AS runs,
           (SELECT COUNT(*) FROM automation_repositories) AS repositories,
           (SELECT COUNT(*) FROM automation_environments) AS environments`
      ).first()
    ).toEqual({ invocations: 1, runs: 1, repositories: 1, environments: 1 });

    const foreignKeyViolations = await env.DB.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeyViolations.results).toEqual([]);
  });
});
