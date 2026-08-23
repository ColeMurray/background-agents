import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

const now = 1_700_000_000_000;

async function seedAccount(
  id: string,
  provider: "openai" | "xai",
  status: "active" | "disabled" = "active",
  archivedAt: number | null = null
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO model_provider_accounts
      (id, provider, display_name, status, created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, provider, id, status, now, now, archivedAt)
    .run();
}

async function applyMigration(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0068"));
  if (!migration) throw new Error("Migration 0068 not found in TEST_MIGRATIONS");
  await env.DB.batch(migration.queries.map((query) => env.DB.prepare(query)));
}

describe("migration 0068: default single provider accounts", () => {
  beforeEach(cleanD1Tables);
  afterEach(cleanD1Tables);

  it("defaults the sole active account without choosing between multiple accounts", async () => {
    await seedAccount("xai-only", "xai");
    await seedAccount("openai-one", "openai");
    await seedAccount("openai-two", "openai");

    await applyMigration();

    const defaults = await env.DB.prepare(
      `SELECT provider, provider_account_id, unattended_mode
       FROM model_provider_account_defaults ORDER BY provider`
    ).all();
    expect(defaults.results).toEqual([
      {
        provider: "xai",
        provider_account_id: "xai-only",
        unattended_mode: "provider_account",
      },
    ]);
  });

  it("preserves an existing default", async () => {
    await seedAccount("existing", "xai");
    await seedAccount("newer", "xai");
    await env.DB.prepare(
      `INSERT INTO model_provider_account_defaults
        (provider, provider_account_id, unattended_mode, created_at, updated_at)
       VALUES ('xai', 'existing', 'api_key', ?, ?)`
    )
      .bind(now, now)
      .run();

    await applyMigration();

    expect(
      await env.DB.prepare(
        "SELECT provider_account_id, unattended_mode FROM model_provider_account_defaults WHERE provider = 'xai'"
      ).first()
    ).toEqual({ provider_account_id: "existing", unattended_mode: "api_key" });
  });

  it("ignores disabled and archived accounts", async () => {
    await seedAccount("disabled", "xai", "disabled");
    await seedAccount("archived", "openai", "active", now);

    await applyMigration();

    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM model_provider_account_defaults").first()
    ).toEqual({ count: 0 });
  });
});
