import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../../terraform/d1/migrations/", import.meta.url)
);
const PROJECTION_MIGRATION = "0051_enforce_better_auth_canonical_users.sql";

function applyMigrationsBeforeProjection(db: DatabaseSync): void {
  const migrationFiles = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file) && file < PROJECTION_MIGRATION)
    .sort();

  for (const migrationFile of migrationFiles) {
    db.exec(readFileSync(`${MIGRATIONS_DIRECTORY}/${migrationFile}`, "utf8"));
  }
}

function projectionMigrationSql(): string {
  return readFileSync(`${MIGRATIONS_DIRECTORY}/${PROJECTION_MIGRATION}`, "utf8");
}

describe("Better Auth canonical-user projection migration", () => {
  it("atomically projects auth user inserts and profile updates", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyMigrationsBeforeProjection(db);
      db.exec(projectionMigrationSql());

      db.exec(`
        INSERT INTO auth_users (
          id, name, email, emailVerified, image, createdAt, updatedAt
        ) VALUES (
          '11111111111111111111111111111111',
          '  Projected User  ',
          '  PROJECTED@EXAMPLE.COM  ',
          1,
          'https://avatars.example/initial',
          '2026-07-26T21:47:56.123Z',
          '2026-07-26T21:47:57.456Z'
        );
      `);

      expect(
        db
          .prepare(
            `SELECT id, display_name, email, avatar_url, created_at, updated_at
             FROM users
             WHERE id = '11111111111111111111111111111111'`
          )
          .get()
      ).toEqual({
        id: "11111111111111111111111111111111",
        display_name: "Projected User",
        email: "projected@example.com",
        avatar_url: "https://avatars.example/initial",
        created_at: Date.parse("2026-07-26T21:47:56.123Z"),
        updated_at: Date.parse("2026-07-26T21:47:57.456Z"),
      });

      db.exec(`
        UPDATE auth_users
        SET name = 'Updated User',
            email = 'updated@example.com',
            image = 'https://avatars.example/updated',
            updatedAt = '2026-07-27T00:00:00.789Z'
        WHERE id = '11111111111111111111111111111111';
      `);

      expect(
        db
          .prepare(
            `SELECT display_name, email, avatar_url, updated_at
             FROM users
             WHERE id = '11111111111111111111111111111111'`
          )
          .get()
      ).toEqual({
        display_name: "Updated User",
        email: "updated@example.com",
        avatar_url: "https://avatars.example/updated",
        updated_at: Date.parse("2026-07-27T00:00:00.789Z"),
      });

      db.exec(`
        INSERT INTO users (
          id, display_name, email, avatar_url, created_at, updated_at
        ) VALUES (
          '22222222222222222222222222222222',
          'Existing User',
          'collision@example.com',
          NULL,
          1785000000000,
          1785000000000
        );
      `);

      expect(() =>
        db.exec(`
          INSERT INTO auth_users (
            id, name, email, emailVerified, image, createdAt, updatedAt
          ) VALUES (
            '33333333333333333333333333333333',
            'Conflicting User',
            'collision@example.com',
            1,
            NULL,
            '2026-07-27T00:00:00.000Z',
            '2026-07-27T00:00:00.000Z'
          );
        `)
      ).toThrow(/UNIQUE constraint failed: users\.email/);
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM auth_users
             WHERE id = '33333333333333333333333333333333'`
          )
          .get()
      ).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("repairs safe orphans and revokes conflicting identity graphs", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyMigrationsBeforeProjection(db);
      db.exec(`
        INSERT INTO auth_users (
          id, name, email, emailVerified, image, createdAt, updatedAt
        ) VALUES
          (
            '44444444444444444444444444444444',
            'Recoverable User',
            'recoverable@example.com',
            1,
            NULL,
            '2026-07-27T00:00:00.000Z',
            '2026-07-27T00:00:00.000Z'
          ),
          (
            '55555555555555555555555555555555',
            'Conflicting User',
            'reserved@example.com',
            1,
            NULL,
            '2026-07-27T00:00:00.000Z',
            '2026-07-27T00:00:00.000Z'
          );

        INSERT INTO users (
          id, display_name, email, avatar_url, created_at, updated_at
        ) VALUES (
          '66666666666666666666666666666666',
          'Canonical Owner',
          'reserved@example.com',
          NULL,
          1785000000000,
          1785000000000
        );

        INSERT INTO auth_accounts (
          id, accountId, providerId, userId, createdAt, updatedAt
        ) VALUES
          (
            'recoverable-account',
            'recoverable-subject',
            'github',
            '44444444444444444444444444444444',
            '2026-07-27T00:00:00.000Z',
            '2026-07-27T00:00:00.000Z'
          ),
          (
            'conflicting-account',
            'conflicting-subject',
            'github',
            '55555555555555555555555555555555',
            '2026-07-27T00:00:00.000Z',
            '2026-07-27T00:00:00.000Z'
          );

        INSERT INTO auth_sessions (
          id, expiresAt, token, createdAt, updatedAt, userId
        ) VALUES (
          'conflicting-session',
          '2026-08-03T00:00:00.000Z',
          'conflicting-session-token',
          '2026-07-27T00:00:00.000Z',
          '2026-07-27T00:00:00.000Z',
          '55555555555555555555555555555555'
        );
      `);

      const migrationSql = projectionMigrationSql();
      db.exec(migrationSql);

      expect(
        db
          .prepare(
            `SELECT id, email
             FROM users
             WHERE id = '44444444444444444444444444444444'`
          )
          .get()
      ).toEqual({
        id: "44444444444444444444444444444444",
        email: "recoverable@example.com",
      });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM auth_accounts
             WHERE id = 'recoverable-account'`
          )
          .get()
      ).toEqual({ count: 1 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM auth_users
             WHERE id = '55555555555555555555555555555555'`
          )
          .get()
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM auth_accounts
             WHERE id = 'conflicting-account'`
          )
          .get()
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM auth_sessions
             WHERE id = 'conflicting-session'`
          )
          .get()
      ).toEqual({ count: 0 });

      db.exec(migrationSql);
      expect(db.prepare("SELECT COUNT(*) AS count FROM auth_users").get()).toEqual({
        count: 1,
      });
    } finally {
      db.close();
    }
  });
});
