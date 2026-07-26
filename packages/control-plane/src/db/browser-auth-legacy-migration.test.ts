import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../../terraform/d1/migrations/", import.meta.url)
);
const BACKFILL_MIGRATION = "0049_backfill_better_auth_accounts.sql";

function applyMigrationsBeforeBackfill(db: DatabaseSync): void {
  const migrationFiles = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file) && file < BACKFILL_MIGRATION)
    .sort();

  for (const migrationFile of migrationFiles) {
    db.exec(readFileSync(`${MIGRATIONS_DIRECTORY}/${migrationFile}`, "utf8"));
  }
}

describe("Better Auth legacy account backfill migration", () => {
  it("preserves the canonical user for an existing immutable provider identity", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyMigrationsBeforeBackfill(db);
      db.exec(`
        INSERT INTO users (
          id, display_name, email, avatar_url, created_at, updated_at
        ) VALUES (
          '11111111111111111111111111111111',
          'Legacy User',
          'legacy@example.com',
          'https://avatars.example/legacy',
          1785000000000,
          1785000001000
        );

        INSERT INTO user_identities (
          id, user_id, provider, provider_user_id, provider_login,
          provider_email, created_at, provider_issuer
        ) VALUES (
          '22222222222222222222222222222222',
          '11111111111111111111111111111111',
          'github',
          '583231',
          'legacy-user',
          'legacy@example.com',
          1785000000000,
          'https://github.com'
        );

        -- Better Auth's non-atomic D1 fallback inserted this row before the
        -- canonical-user projection rejected its duplicate email.
        INSERT INTO auth_users (
          id, name, email, emailVerified, image, createdAt, updatedAt
        ) VALUES (
          '33333333333333333333333333333333',
          'Legacy User',
          'legacy@example.com',
          1,
          'https://avatars.example/legacy',
          '2026-07-26T21:47:56.000Z',
          '2026-07-26T21:47:56.000Z'
        );

        -- Better Auth creates the provider account in the same logical
        -- transaction as the user. D1's non-atomic transaction fallback can
        -- retain both rows when the post-create canonical projection fails.
        INSERT INTO auth_accounts (
          id, accountId, providerId, userId, createdAt, updatedAt
        ) VALUES (
          'partial-account',
          '583231',
          'github',
          '33333333333333333333333333333333',
          '2026-07-26T21:47:56.000Z',
          '2026-07-26T21:47:56.000Z'
        );

        INSERT INTO auth_sessions (
          id, expiresAt, token, createdAt, updatedAt, userId
        ) VALUES (
          'partial-session',
          '2026-08-02T21:47:56.000Z',
          'partial-session-token',
          '2026-07-26T21:47:56.000Z',
          '2026-07-26T21:47:56.000Z',
          '33333333333333333333333333333333'
        );
      `);

      const migrationSql = readFileSync(`${MIGRATIONS_DIRECTORY}/${BACKFILL_MIGRATION}`, "utf8");
      db.exec(migrationSql);

      expect(
        db
          .prepare(
            `SELECT id, name, email, emailVerified, image
             FROM auth_users`
          )
          .get()
      ).toEqual({
        id: "11111111111111111111111111111111",
        name: "Legacy User",
        email: "legacy@example.com",
        emailVerified: 0,
        image: "https://avatars.example/legacy",
      });
      expect(
        db
          .prepare(
            `SELECT id, accountId, providerId, userId, accessToken, refreshToken
             FROM auth_accounts`
          )
          .get()
      ).toEqual({
        id: "22222222222222222222222222222222",
        accountId: "583231",
        providerId: "github",
        userId: "11111111111111111111111111111111",
        accessToken: null,
        refreshToken: null,
      });

      // A lost migration response can safely be retried.
      db.exec(migrationSql);
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_users").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_accounts").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_sessions").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("reserves a legacy canonical email without implicitly linking a provider", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyMigrationsBeforeBackfill(db);
      db.exec(`
        INSERT INTO users (
          id, display_name, email, avatar_url, created_at, updated_at
        ) VALUES (
          '44444444444444444444444444444444',
          'Bot-created User',
          'bot-created@example.com',
          NULL,
          1785000000000,
          1785000001000
        );

        INSERT INTO auth_users (
          id, name, email, emailVerified, image, createdAt, updatedAt
        ) VALUES (
          '55555555555555555555555555555555',
          'Bot-created User',
          'bot-created@example.com',
          1,
          NULL,
          '2026-07-26T21:47:56.000Z',
          '2026-07-26T21:47:56.000Z'
        );
      `);

      db.exec(readFileSync(`${MIGRATIONS_DIRECTORY}/${BACKFILL_MIGRATION}`, "utf8"));

      expect(db.prepare("SELECT id, emailVerified FROM auth_users").get()).toEqual({
        id: "44444444444444444444444444444444",
        emailVerified: 0,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_accounts").get()).toEqual({
        count: 0,
      });
    } finally {
      db.close();
    }
  });
});
