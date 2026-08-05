import { env } from "cloudflare:test";

/**
 * Seed helpers for canonical/auth identity-registry tests. Timestamps default
 * to a fixed instant so DATE→epoch conversions are assertable.
 */

export const SEED_NOW_MS = Date.parse("2026-08-01T00:00:00.000Z");
export const SEED_NOW_ISO = new Date(SEED_NOW_MS).toISOString();

export async function insertCanonicalUser(options: {
  id: string;
  email: string | null;
  displayName?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, email, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, NULL, ?, ?)`
  )
    .bind(options.id, options.displayName ?? null, options.email, SEED_NOW_MS, SEED_NOW_MS)
    .run();
}

export async function insertIdentity(options: {
  id: string;
  userId: string;
  provider: string;
  providerUserId: string;
  issuer?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_identities (
       id, user_id, provider, provider_user_id, provider_login,
       provider_email, provider_issuer, created_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
  )
    .bind(
      options.id,
      options.userId,
      options.provider,
      options.providerUserId,
      options.issuer ?? null,
      SEED_NOW_MS
    )
    .run();
}

export async function insertAuthUser(options: {
  id: string;
  email: string;
  emailVerified?: number;
  name?: string;
  createdAtIso?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO auth_users (id, name, email, emailVerified, image, createdAt, updatedAt)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(
      options.id,
      options.name ?? options.email,
      options.email,
      options.emailVerified ?? 0,
      options.createdAtIso ?? SEED_NOW_ISO,
      options.createdAtIso ?? SEED_NOW_ISO
    )
    .run();
}

export async function insertAuthAccount(options: {
  id: string;
  accountId: string;
  providerId: string;
  userId: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO auth_accounts (
       id, accountId, providerId, userId, accessToken, refreshToken, idToken,
       accessTokenExpiresAt, refreshTokenExpiresAt, scope, password, createdAt, updatedAt
     ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
  )
    .bind(
      options.id,
      options.accountId,
      options.providerId,
      options.userId,
      SEED_NOW_ISO,
      SEED_NOW_ISO
    )
    .run();
}

export async function insertAuthSession(options: { id: string; userId: string }): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO auth_sessions (id, expiresAt, token, createdAt, updatedAt, userId)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(
      options.id,
      SEED_NOW_ISO,
      `token-${options.id}`,
      SEED_NOW_ISO,
      SEED_NOW_ISO,
      options.userId
    )
    .run();
}

export async function getAuthUserRow(
  id: string
): Promise<{ id: string; name: string; email: string; emailVerified: number } | null> {
  return env.DB.prepare(`SELECT id, name, email, emailVerified FROM auth_users WHERE id = ?`)
    .bind(id)
    .first<{ id: string; name: string; email: string; emailVerified: number }>();
}

export async function countTableRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}
