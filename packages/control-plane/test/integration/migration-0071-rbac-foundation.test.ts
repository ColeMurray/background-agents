import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanD1Tables } from "./cleanup";

const migration = () => {
  const entry = env.TEST_MIGRATIONS.find((candidate) => candidate.name.startsWith("0071"));
  if (!entry) throw new Error("Migration 0071 not found in TEST_MIGRATIONS");
  return entry;
};

async function tableColumns(table: string): Promise<string[]> {
  const result = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{ name: string }>();
  return result.results.map((column) => column.name);
}

async function restoreMigration(): Promise<void> {
  if (!(await tableColumns("users")).includes("suspended_at")) {
    await env.DB.batch(migration().queries.map((query) => env.DB.prepare(query)));
  }
}

beforeEach(cleanD1Tables);
afterEach(async () => {
  await restoreMigration();
  await cleanD1Tables();
});

describe("migration 0071: RBAC foundation", () => {
  it("backfills existing users before enabling Member defaults", async () => {
    await env.DB.exec(`
      DROP TRIGGER assign_default_role_after_user_insert;
      DROP TABLE authorization_audit_events;
      DROP TABLE user_role_assignments;
      DROP TABLE role_permissions;
      DROP TABLE roles;
      ALTER TABLE users DROP COLUMN suspended_at;
    `);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
          (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
         VALUES
          ('11111111111111111111111111111111', 'Existing One', 'one@example.com', 1, NULL, 100, 100),
          ('22222222222222222222222222222222', 'Existing Two', 'two@example.com', 1, NULL, 200, 200)`
      ),
      env.DB.prepare(
        `INSERT INTO sessions
          (id, repo_owner, repo_name, status, created_at, updated_at, user_id)
         VALUES
          ('existing-session', 'acme', 'repo', 'completed', 300, 300,
           '11111111111111111111111111111111'),
           ('anonymous-session', 'acme', 'repo', 'completed', 400, 400, NULL)`
      ),
      env.DB.prepare(
        `INSERT INTO user_identities
          (id, user_id, provider, provider_user_id, provider_issuer, created_at, updated_at)
         VALUES ('existing-identity', '11111111111111111111111111111111',
           'github', 'legacy-github-id', 'https://github.com', 100, 100)`
      ),
      env.DB.prepare(
        `INSERT INTO automations
          (id, name, instructions, model, created_by, user_id, created_at, updated_at)
         VALUES ('existing-automation', 'Existing', 'Run', 'anthropic/claude-sonnet-4-6',
           'legacy-github-id', NULL, 100, 100)`
      ),
    ]);

    await env.DB.batch(migration().queries.map((query) => env.DB.prepare(query)));

    expect(
      await env.DB.prepare(
        `SELECT u.id, u.suspended_at, r.key AS role_key
         FROM users u
         JOIN user_role_assignments ura ON ura.user_id = u.id
         JOIN roles r ON r.id = ura.role_id
         ORDER BY u.id`
      ).all()
    ).toMatchObject({
      results: [
        {
          id: "11111111111111111111111111111111",
          suspended_at: null,
          role_key: "administrator",
        },
        {
          id: "22222222222222222222222222222222",
          suspended_at: null,
          role_key: "administrator",
        },
      ],
    });
    expect(
      await env.DB.prepare(
        "SELECT user_id FROM automations WHERE id = 'existing-automation'"
      ).first()
    ).toEqual({ user_id: "11111111111111111111111111111111" });
    expect(await tableColumns("roles")).toEqual([
      "id",
      "key",
      "name",
      "normalized_name",
      "description",
      "is_system",
    ]);
    expect(await tableColumns("user_role_assignments")).toEqual(["user_id", "role_id"]);
    expect(await tableColumns("authorization_audit_events")).toEqual([
      "id",
      "occurred_at",
      "request_id",
      "principal_kind",
      "actor_user_id_snapshot",
      "actor_service_snapshot",
      "action",
      "resource_type",
      "resource_id",
      "target_user_id_snapshot",
      "reason_code",
    ]);

    await env.DB.prepare(
      `INSERT INTO users
        (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
       VALUES ('33333333333333333333333333333333', 'New User', NULL, 0, NULL, 500, 500)`
    ).run();
    expect(
      await env.DB.prepare(
        `SELECT r.key FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id
         WHERE ura.user_id = '33333333333333333333333333333333'`
      ).first()
    ).toEqual({ key: "member" });
    expect((await env.DB.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
  });
});
