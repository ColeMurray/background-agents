import { beforeEach, describe, expect, it } from "vitest";
import { env } from "cloudflare:test";
import { cleanD1Tables } from "./cleanup";

const EXPECTED_TABLES = [
  "browser_auth_sessions",
  "oauth_authorization_codes",
  "oauth_flow_state",
  "provider_credentials",
  "verified_email_claims",
] as const;

const REQUIRED_TEXT_PRIMARY_KEYS = [
  ["browser_auth_sessions", "id"],
  ["oauth_authorization_codes", "id"],
  ["oauth_flow_state", "id"],
  ["provider_credentials", "provider_identity_id"],
  ["verified_email_claims", "email"],
] as const;

describe("terminal browser-auth schema", () => {
  beforeEach(cleanD1Tables);

  it("creates the focused tables with non-null text primary keys", async () => {
    const placeholders = EXPECTED_TABLES.map(() => "?").join(", ");
    const tables = await env.DB.prepare(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name IN (${placeholders})
       ORDER BY name`
    )
      .bind(...EXPECTED_TABLES)
      .all<{ name: string }>();

    expect(tables.results.map(({ name }) => name)).toEqual([...EXPECTED_TABLES].sort());

    for (const [table, primaryKey] of REQUIRED_TEXT_PRIMARY_KEYS) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
        notnull: number;
        pk: number;
        type: string;
      }>();
      expect(columns.results.find(({ name }) => name === primaryKey)).toMatchObject({
        name: primaryKey,
        notnull: 1,
        pk: 1,
        type: "TEXT",
      });
    }
  });

  it("rejects terminal rows whose provider identity belongs to another user", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
         VALUES ('user-1', NULL, NULL, NULL, 1, 1)`
      ),
      env.DB.prepare(
        `INSERT INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
         VALUES ('user-2', NULL, NULL, NULL, 1, 1)`
      ),
      env.DB.prepare(
        `INSERT INTO user_identities
         (id, user_id, provider, provider_issuer, provider_user_id, created_at)
         VALUES (
           'identity-2', 'user-2', 'github', 'https://github.com',
           'github-subject-2', 1
         )`
      ),
    ]);

    await expect(
      env.DB.prepare(
        `INSERT INTO browser_auth_sessions
         (id, token_hash, user_id, client_id, provider_identity_id,
          created_at, last_used_at, expires_at, absolute_expires_at)
         VALUES ('session-1', ?, 'user-1', 'web', 'identity-2', 1, 1, 2, 3)`
      )
        .bind("a".repeat(64))
        .run()
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    await expect(
      env.DB.prepare(
        `INSERT INTO oauth_authorization_codes
         (id, code_hash, user_id, provider_identity_id, client_id,
          redirect_uri, code_challenge, created_at, expires_at)
         VALUES (
           'code-1', ?, 'user-1', 'identity-2', 'web',
           'https://web.example/callback', ?, 1, 2
         )`
      )
        .bind("b".repeat(64), "c".repeat(43))
        .run()
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);

    await expect(
      env.DB.prepare(
        `INSERT INTO verified_email_claims
         (email, user_id, source_kind, source_provider_identity_id,
          created_at, last_verified_at)
         VALUES (
           'user@example.com', 'user-1', 'provider_verified',
           'identity-2', 1, 1
         )`
      ).run()
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  it("enforces provider-credential row shapes and supported storage versions", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
         VALUES ('user-1', NULL, NULL, NULL, 1, 1)`
      ),
      env.DB.prepare(
        `INSERT INTO user_identities
         (id, user_id, provider, provider_issuer, provider_user_id, created_at)
         VALUES (
           'identity-1', 'user-1', 'github', 'https://github.com',
           'github-subject-1', 1
         )`
      ),
    ]);

    const insertCredential = (
      kind: string,
      accessExpiresAt: number | null,
      refreshCiphertext: string | null,
      refreshExpiresAt: number | null,
      encryptionVersion = 1
    ) =>
      env.DB.prepare(
        `INSERT INTO provider_credentials
         (provider_identity_id, credential_kind, access_token_ciphertext,
          access_expires_at, refresh_token_ciphertext, refresh_expires_at,
          encryption_key_version, row_version, updated_at)
         VALUES ('identity-1', ?, 'access-ciphertext', ?, ?, ?, ?, 1, 1)`
      )
        .bind(kind, accessExpiresAt, refreshCiphertext, refreshExpiresAt, encryptionVersion)
        .run();

    await expect(
      insertCredential("access_only_expiring", 2, "unexpected-refresh", null)
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertCredential("access_only_nonexpiring", 2, null, null)).rejects.toThrow(
      /CHECK constraint failed/
    );
    await expect(insertCredential("refreshable", 2, "refresh-ciphertext", null, 2)).rejects.toThrow(
      /CHECK constraint failed/
    );
    await expect(
      insertCredential("refreshable", 2, "refresh-ciphertext", null)
    ).resolves.toMatchObject({ meta: { changes: 1 } });
  });

  it("enforces normalized verified-email provenance", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users
         (id, display_name, email, avatar_url, created_at, updated_at)
         VALUES ('user-1', NULL, NULL, NULL, 1, 1)`
      ),
      env.DB.prepare(
        `INSERT INTO user_identities
         (id, user_id, provider, provider_issuer, provider_user_id, created_at)
         VALUES (
           'identity-1', 'user-1', 'google', 'https://accounts.google.com',
           'google-subject-1', 1
         )`
      ),
    ]);

    await expect(
      env.DB.prepare(
        `INSERT INTO verified_email_claims
         (email, user_id, source_kind, source_provider_identity_id,
          created_at, last_verified_at)
         VALUES (
           'User@Example.com', 'user-1', 'provider_verified',
           'identity-1', 1, 1
         )`
      ).run()
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO verified_email_claims
         (email, user_id, source_kind, source_provider_identity_id,
          created_at, last_verified_at)
         VALUES (
           'user@example.com', 'user-1', 'legacy_canonical',
           'identity-1', 1, 1
         )`
      ).run()
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(
      env.DB.prepare(
        `INSERT INTO verified_email_claims
         (email, user_id, source_kind, source_provider_identity_id,
          created_at, last_verified_at)
         VALUES (
           'user@example.com', 'user-1', 'provider_verified',
           'identity-1', 1, 1
         )`
      ).run()
    ).resolves.toMatchObject({ meta: { changes: 1 } });
  });

  it("passes SQLite integrity diagnostics after applying the migration", async () => {
    const foreignKeyFailures = await env.DB.prepare("PRAGMA foreign_key_check").all();
    const quickCheck = await env.DB.prepare("PRAGMA quick_check").all();

    expect(foreignKeyFailures.results).toEqual([]);
    expect(quickCheck.results).toEqual([{ quick_check: "ok" }]);
  });
});
