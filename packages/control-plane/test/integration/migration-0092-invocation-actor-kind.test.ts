import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

async function hasActorKindSchema(): Promise<boolean> {
  const columns = await env.DB.prepare("PRAGMA table_info(automation_invocations)").all<{
    name: string;
  }>();
  const index = await env.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_invocations_actor_created'"
  ).first();
  return columns.results.some((column) => column.name === "actor_kind") && index !== null;
}

async function applyMigration0092(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0092"));
  if (!migration) throw new Error("Migration 0092 not found in TEST_MIGRATIONS");
  await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));
}

/** Full-history setup covers fresh databases; remove what 0092 adds. */
async function resetToPre0092(): Promise<void> {
  await env.DB.prepare("DROP INDEX IF EXISTS idx_invocations_actor_created").run();
  await env.DB.prepare("ALTER TABLE automation_invocations DROP COLUMN actor_kind").run();
}

async function insertInvocation(
  id: string,
  source: string,
  triggerMetadata: string | null,
  skipReason: string | null = null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO automation_invocations
       (id, automation_id, source, scheduled_at, trigger_metadata, skip_reason, created_at,
        updated_at)
     VALUES (?, 'auto-1', ?, ?, ?, ?, 1000, 1000)`
  )
    .bind(id, source, source === "schedule" ? 1000 : null, triggerMetadata, skipReason)
    .run();
}

afterEach(async () => {
  await cleanD1Tables();
  if (!(await hasActorKindSchema())) {
    await resetToPre0092().catch(() => undefined);
    await applyMigration0092();
  }
});

describe("migration 0092: invocation actor kind", () => {
  it("labels legacy Slack firings by their author and leaves the rest unknown", async () => {
    await resetToPre0092();
    await env.DB.prepare(
      `INSERT INTO automations
         (id, name, instructions, trigger_type, schedule_tz, model, enabled,
          consecutive_failures, created_by, created_at, updated_at)
       VALUES ('auto-1', 'Alerts', 'Inspect', 'slack_event', 'UTC', 'test-model', 1,
               0, 'user-1', 1000, 1000)`
    ).run();
    const botMetadata = JSON.stringify({ channel: "C1", messageTs: "1", botId: "B1" });
    await insertInvocation("bot", "event", botMetadata);
    await insertInvocation("bot-skip", "event", botMetadata, "slack_bot_trigger_limit");
    await insertInvocation("person", "event", JSON.stringify({ channel: "C1", messageTs: "2" }));
    await insertInvocation("github", "event", null);
    await insertInvocation("schedule", "schedule", null);
    await insertInvocation("manual", "manual", null);

    await applyMigration0092();

    const rows = await env.DB.prepare(
      "SELECT id, actor_kind FROM automation_invocations ORDER BY id"
    ).all<{ id: string; actor_kind: string }>();
    expect(Object.fromEntries(rows.results.map((row) => [row.id, row.actor_kind]))).toEqual({
      bot: "bot",
      "bot-skip": "bot",
      person: "person",
      github: "unknown",
      schedule: "unknown",
      manual: "unknown",
    });

    // A worker that predates the column still inserts; its rows take the default.
    await insertInvocation("previous-worker", "event", botMetadata);
    const previous = await env.DB.prepare(
      "SELECT actor_kind FROM automation_invocations WHERE id = 'previous-worker'"
    ).first<{ actor_kind: string }>();
    expect(previous?.actor_kind).toBe("unknown");

    expect(await hasActorKindSchema()).toBe(true);
  });
});
