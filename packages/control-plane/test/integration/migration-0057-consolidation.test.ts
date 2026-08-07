import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Fold-in safety tests for migration 0057 (Better Auth → canonical registry
 * consolidation). The harness applies all migrations up front, so each test
 * reconstructs the PRE-0057 schema (canonical tables without the new columns,
 * plus the parallel auth tables from 0048), seeds one drift state, executes
 * the real 0057 statements from TEST_MIGRATIONS, and asserts the folded
 * outcome. A failing statement would abort the Terraform apply, so every
 * seedable drift state must complete.
 *
 * D1 isolation is per test FILE — the schema surgery here cannot leak into
 * other suites.
 */

const PRE_0057_SCHEMA = [
  `DROP TABLE IF EXISTS auth_verifications`,
  `DROP TABLE IF EXISTS auth_sessions`,
  `DROP TABLE IF EXISTS auth_accounts`,
  `DROP TABLE IF EXISTS auth_users`,
  `DROP TABLE IF EXISTS user_identities`,
  `DROP TABLE IF EXISTS users`,
  // 0019 shape (+ 0047's provider_issuer)
  `CREATE TABLE users (
     id           TEXT    PRIMARY KEY,
     display_name TEXT,
     email        TEXT,
     avatar_url   TEXT,
     created_at   INTEGER NOT NULL,
     updated_at   INTEGER NOT NULL
   )`,
  `CREATE UNIQUE INDEX idx_users_email
     ON users(email COLLATE NOCASE) WHERE email IS NOT NULL`,
  `CREATE TABLE user_identities (
     id               TEXT PRIMARY KEY,
     user_id          TEXT NOT NULL,
     provider         TEXT NOT NULL,
     provider_user_id TEXT NOT NULL,
     provider_login   TEXT,
     provider_email   TEXT,
     provider_issuer  TEXT,
     created_at       INTEGER NOT NULL,
     FOREIGN KEY (user_id) REFERENCES users(id)
   )`,
  `CREATE UNIQUE INDEX idx_user_identities_provider
     ON user_identities(provider, provider_user_id)`,
  `CREATE INDEX idx_user_identities_user ON user_identities(user_id)`,
  // 0048 shape
  `CREATE TABLE auth_users (
     id              TEXT NOT NULL PRIMARY KEY,
     name            TEXT NOT NULL,
     email           TEXT NOT NULL UNIQUE,
     emailVerified   INTEGER NOT NULL,
     image           TEXT,
     createdAt       DATE NOT NULL,
     updatedAt       DATE NOT NULL
   )`,
  `CREATE TABLE auth_sessions (
     id          TEXT NOT NULL PRIMARY KEY,
     expiresAt   DATE NOT NULL,
     token       TEXT NOT NULL UNIQUE,
     createdAt   DATE NOT NULL,
     updatedAt   DATE NOT NULL,
     ipAddress   TEXT,
     userAgent   TEXT,
     userId      TEXT NOT NULL,
     FOREIGN KEY (userId) REFERENCES auth_users(id) ON DELETE CASCADE
   )`,
  `CREATE TABLE auth_accounts (
     id                    TEXT NOT NULL PRIMARY KEY,
     accountId             TEXT NOT NULL,
     providerId            TEXT NOT NULL,
     userId                TEXT NOT NULL,
     accessToken           TEXT,
     refreshToken          TEXT,
     idToken               TEXT,
     accessTokenExpiresAt  DATE,
     refreshTokenExpiresAt DATE,
     scope                 TEXT,
     password              TEXT,
     createdAt             DATE NOT NULL,
     updatedAt             DATE NOT NULL,
     FOREIGN KEY (userId) REFERENCES auth_users(id) ON DELETE CASCADE
   )`,
  `CREATE UNIQUE INDEX idx_auth_accounts_provider_identity
     ON auth_accounts(providerId, accountId)`,
  `CREATE TABLE auth_verifications (
     id          TEXT NOT NULL PRIMARY KEY,
     identifier  TEXT NOT NULL,
     value       TEXT NOT NULL,
     expiresAt   DATE NOT NULL,
     createdAt   DATE NOT NULL,
     updatedAt   DATE NOT NULL
   )`,
];

const SEED_ISO = "2026-08-01T00:00:00.000Z";
const SEED_MS = Date.parse(SEED_ISO);

async function resetToPre0057(): Promise<void> {
  for (const statement of PRE_0057_SCHEMA) {
    await env.DB.prepare(statement).run();
  }
}

async function applyConsolidation(): Promise<void> {
  const migration = env.TEST_MIGRATIONS.find((entry) => entry.name.startsWith("0057"));
  if (!migration) throw new Error("Migration 0057 not found in TEST_MIGRATIONS");
  for (const query of migration.queries) {
    await env.DB.prepare(query).run();
  }
}

async function seedCanonical(id: string, email: string | null, displayName?: string) {
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, email, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  )
    .bind(id, displayName ?? null, email, SEED_MS, SEED_MS)
    .run();
}

async function seedAuthUser(id: string, email: string, emailVerified = 1, name = "Auth User") {
  await env.DB.prepare(
    `INSERT INTO auth_users (id, name, email, emailVerified, image, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(id, name, email, emailVerified, SEED_ISO, SEED_ISO)
    .run();
}

async function seedAuthAccount(options: {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
  accessToken?: string | null;
  createdAtIso?: string;
}) {
  await env.DB.prepare(
    `INSERT INTO auth_accounts (id, accountId, providerId, userId, accessToken, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      options.id,
      options.accountId,
      options.providerId,
      options.userId,
      options.accessToken ?? null,
      options.createdAtIso ?? SEED_ISO,
      options.createdAtIso ?? SEED_ISO
    )
    .run();
}

async function seedIdentity(options: {
  id: string;
  userId: string;
  provider: string;
  providerUserId: string;
}) {
  await env.DB.prepare(
    `INSERT INTO user_identities (id, user_id, provider, provider_user_id, provider_issuer, created_at)
     VALUES (?, ?, ?, ?, 'https://github.com', ?)`
  )
    .bind(options.id, options.userId, options.provider, options.providerUserId, SEED_MS)
    .run();
}

async function userRow(id: string) {
  return env.DB.prepare(`SELECT id, email, email_verified, display_name FROM users WHERE id = ?`)
    .bind(id)
    .first<{
      id: string;
      email: string | null;
      email_verified: number;
      display_name: string | null;
    }>();
}

beforeEach(async () => {
  await resetToPre0057();
});

describe("migration 0057: Better Auth → canonical consolidation", () => {
  it("merges same-id auth rows: NULL-email canonical rows acquire the verified auth email", async () => {
    const userId = "11111111111111111111111111111111";
    await seedCanonical(userId, null);
    await seedAuthUser(userId, "person@example.com", 1, "Web Person");

    await applyConsolidation();

    expect(await userRow(userId)).toMatchObject({
      email: "person@example.com",
      email_verified: 1,
      display_name: "Web Person",
    });
    // The parallel registry is gone.
    const tables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('auth_users', 'auth_accounts')`
    ).all();
    expect(tables.results).toEqual([]);
  });

  it("creates canonical users from web-only auth rows, carrying accounts and credentials", async () => {
    const webOnlyId = "21111111111111111111111111111111";
    await seedAuthUser(webOnlyId, "web.only@example.com", 1, "Web Only");
    await seedAuthAccount({
      id: "a2111111111111111111111111111111",
      accountId: "583231",
      providerId: "github",
      userId: webOnlyId,
      accessToken: "ciphertext-access",
    });

    await applyConsolidation();

    expect(await userRow(webOnlyId)).toMatchObject({
      email: "web.only@example.com",
      email_verified: 1,
    });
    const identity = await env.DB.prepare(
      `SELECT user_id, provider_issuer, access_token, created_at FROM user_identities
       WHERE provider = 'github' AND provider_user_id = '583231'`
    ).first<{
      user_id: string;
      provider_issuer: string;
      access_token: string;
      created_at: number;
    }>();
    expect(identity).toMatchObject({
      user_id: webOnlyId,
      provider_issuer: "https://github.com",
      access_token: "ciphertext-access",
    });
    expect(identity?.created_at).toBe(SEED_MS);
  });

  it("supersedes strands whose email a different canonical user owns (no fold, no abort)", async () => {
    const canonicalId = "31111111111111111111111111111111";
    const strandId = "39999999999999999999999999999999";
    await seedCanonical(canonicalId, "person@example.com");
    // Failed-registration strand holding the same person's email under a
    // generated id, with a partial account and a live session.
    await seedAuthUser(strandId, "person@example.com", 0);
    await seedAuthAccount({
      id: "a3111111111111111111111111111111",
      accountId: "gh-31",
      providerId: "github",
      userId: strandId,
    });
    await env.DB.prepare(
      `INSERT INTO auth_sessions (id, expiresAt, token, createdAt, updatedAt, userId)
       VALUES ('s31', ?, 'tok-31', ?, ?, ?)`
    )
      .bind(SEED_ISO, SEED_ISO, SEED_ISO, strandId)
      .run();

    await applyConsolidation();

    // The strand did not become a user; the canonical owner is verified, so
    // the person's next sign-in email-links onto their real row.
    expect(await userRow(strandId)).toBeNull();
    expect(await userRow(canonicalId)).toMatchObject({
      email: "person@example.com",
      email_verified: 1,
    });
    expect(
      await env.DB.prepare(
        `SELECT id FROM user_identities WHERE provider_user_id = 'gh-31'`
      ).first()
    ).toBeNull();
    // Its session went with it.
    expect(
      await env.DB.prepare(`SELECT id FROM auth_sessions WHERE id = 's31'`).first()
    ).toBeNull();
  });

  it("verifies the emailed backlog and leaves NULL-email rows unverified", async () => {
    const emailedId = "41111111111111111111111111111111";
    const emaillessId = "42111111111111111111111111111111";
    await seedCanonical(emailedId, "slack.person@example.com");
    await seedCanonical(emaillessId, null);

    await applyConsolidation();

    expect(await userRow(emailedId)).toMatchObject({ email_verified: 1 });
    expect(await userRow(emaillessId)).toMatchObject({ email: null, email_verified: 0 });
  });

  it("normalizes legacy canonical emails so exact-match sign-in lookups find them", async () => {
    const userId = "51111111111111111111111111111111";
    await seedCanonical(userId, " Person@Example.COM ");

    await applyConsolidation();

    expect(await userRow(userId)).toMatchObject({
      email: "person@example.com",
      email_verified: 1,
    });
  });

  it("grafts credentials onto same-owner identities and never across owners", async () => {
    const ownerId = "61111111111111111111111111111111";
    await seedCanonical(ownerId, "owner@example.com");
    await seedAuthUser(ownerId, "owner@example.com");
    await seedIdentity({
      id: "i6111111111111111111111111111111",
      userId: ownerId,
      provider: "github",
      providerUserId: "777",
    });
    await seedAuthAccount({
      id: "a6111111111111111111111111111111",
      accountId: "777",
      providerId: "github",
      userId: ownerId,
      accessToken: "owner-ciphertext",
    });

    // Cross-owner conflict shape: bot identity owned by one user, web account
    // for the same subject owned by another.
    const botUserId = "62111111111111111111111111111111";
    const webUserId = "63111111111111111111111111111111";
    await seedCanonical(botUserId, "bot.person@example.com");
    await seedCanonical(webUserId, "web.person@example.com");
    await seedAuthUser(webUserId, "web.person@example.com");
    await seedIdentity({
      id: "i6211111111111111111111111111111",
      userId: botUserId,
      provider: "github",
      providerUserId: "888",
    });
    await seedAuthAccount({
      id: "a6211111111111111111111111111111",
      accountId: "888",
      providerId: "github",
      userId: webUserId,
      accessToken: "web-ciphertext",
    });

    await applyConsolidation();

    const owned = await env.DB.prepare(
      `SELECT access_token, user_id FROM user_identities WHERE provider_user_id = '777'`
    ).first<{ access_token: string | null; user_id: string }>();
    expect(owned).toEqual({ access_token: "owner-ciphertext", user_id: ownerId });
    // Cross-owner: identity keeps its owner and gains no credentials; the
    // conflicting account is superseded with the dropped table.
    const conflicted = await env.DB.prepare(
      `SELECT access_token, user_id FROM user_identities WHERE provider_user_id = '888'`
    ).first<{ access_token: string | null; user_id: string }>();
    expect(conflicted).toEqual({ access_token: null, user_id: botUserId });
  });

  it("re-keys surviving sessions onto canonical users with epoch timestamps", async () => {
    const userId = "71111111111111111111111111111111";
    await seedCanonical(userId, "person@example.com");
    await seedAuthUser(userId, "person@example.com");
    await env.DB.prepare(
      `INSERT INTO auth_sessions (id, expiresAt, token, createdAt, updatedAt, userId)
       VALUES ('s71', ?, 'tok-71', ?, ?, ?)`
    )
      .bind(SEED_ISO, SEED_ISO, SEED_ISO, userId)
      .run();

    await applyConsolidation();

    const session = await env.DB.prepare(
      `SELECT expiresAt, createdAt, userId FROM auth_sessions WHERE id = 's71'`
    ).first<{ expiresAt: number; createdAt: number; userId: string }>();
    expect(session).toEqual({ expiresAt: SEED_MS, createdAt: SEED_MS, userId });
    // FK now targets users: deleting the canonical row cascades the session.
    await env.DB.prepare(`DELETE FROM user_identities WHERE user_id = ?`).bind(userId).run();
    await env.DB.prepare(`DELETE FROM users WHERE id = ?`).bind(userId).run();
    expect(
      await env.DB.prepare(`SELECT id FROM auth_sessions WHERE id = 's71'`).first()
    ).toBeNull();
  });

  it("preserves whitespace-variant canonical email pairs without aborting", async () => {
    const activeId = "81111111111111111111111111111111";
    const variantId = "82111111111111111111111111111111";
    await seedCanonical(activeId, " person@example.com");
    await seedCanonical(variantId, "person@example.com");

    await applyConsolidation();

    // The normalize step's OR IGNORE let the collision stand: one row
    // normalized (or already normal), the other kept its legacy form. Both
    // users and any graphs survive; nothing aborted the deploy.
    const emails = await env.DB.prepare(`SELECT email FROM users ORDER BY id`).all<{
      email: string;
    }>();
    expect(emails.results).toHaveLength(2);
    expect(emails.results.map((row) => row.email)).toContain("person@example.com");
  });

  it("falls back to now for unparseable auth timestamps instead of violating NOT NULL", async () => {
    const userId = "91111111111111111111111111111111";
    await seedAuthUser(userId, "odd.time@example.com");
    await seedAuthAccount({
      id: "a9111111111111111111111111111111",
      accountId: "gh-91",
      providerId: "github",
      userId,
      createdAtIso: "not-a-timestamp",
    });

    await applyConsolidation();

    const identity = await env.DB.prepare(
      `SELECT created_at FROM user_identities WHERE provider_user_id = 'gh-91'`
    ).first<{ created_at: number }>();
    expect(identity).not.toBeNull();
    expect(identity!.created_at).toBeGreaterThan(0);
  });
});
