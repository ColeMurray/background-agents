import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATIONS_DIRECTORY = fileURLToPath(
  new URL("../../../../terraform/d1/migrations/", import.meta.url)
);
const ISSUER_BACKFILL_MIGRATION = "0056_backfill_user_identity_issuers.sql";

function applyMigrationsBeforeIssuerBackfill(db: DatabaseSync): void {
  const migrationFiles = readdirSync(MIGRATIONS_DIRECTORY)
    .filter((file) => /^\d{4}_.+\.sql$/.test(file) && file < ISSUER_BACKFILL_MIGRATION)
    .sort();

  for (const migrationFile of migrationFiles) {
    db.exec(readFileSync(`${MIGRATIONS_DIRECTORY}/${migrationFile}`, "utf8"));
  }
}

describe("user identity issuer backfill migration", () => {
  it("updates only null issuers for sign-in providers", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec("PRAGMA foreign_keys = ON");
      applyMigrationsBeforeIssuerBackfill(db);
      db.exec(`
        INSERT INTO users (
          id, display_name, email, avatar_url, created_at, updated_at
        ) VALUES (
          'canonical-user', 'Canonical User', NULL, NULL, 1785000000000, 1785000001000
        );

        INSERT INTO user_identities (
          id, user_id, provider, provider_user_id, provider_issuer, created_at
        ) VALUES
          ('github-null', 'canonical-user', 'github', 'github-null', NULL, 1785000000000),
          ('google-null', 'canonical-user', 'google', 'google-null', NULL, 1785000000000),
          ('slack-null', 'canonical-user', 'slack', 'slack-null', NULL, 1785000000000),
          ('linear-null', 'canonical-user', 'linear', 'linear-null', NULL, 1785000000000),
          (
            'github-existing',
            'canonical-user',
            'github',
            'github-existing',
            'https://github.example.com',
            1785000000000
          );
      `);

      db.exec(readFileSync(`${MIGRATIONS_DIRECTORY}/${ISSUER_BACKFILL_MIGRATION}`, "utf8"));

      expect(
        db
          .prepare(
            `SELECT id, provider_issuer
             FROM user_identities
             ORDER BY id`
          )
          .all()
      ).toEqual([
        { id: "github-existing", provider_issuer: "https://github.example.com" },
        { id: "github-null", provider_issuer: "https://github.com" },
        { id: "google-null", provider_issuer: "https://accounts.google.com" },
        { id: "linear-null", provider_issuer: null },
        { id: "slack-null", provider_issuer: null },
      ]);
    } finally {
      db.close();
    }
  });
});
