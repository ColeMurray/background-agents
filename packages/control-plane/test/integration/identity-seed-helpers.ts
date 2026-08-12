import { env } from "cloudflare:test";

/**
 * Seed helpers for canonical identity-registry tests. Timestamps default to a
 * fixed instant so epoch conversions are assertable.
 */

export const SEED_NOW_MS = Date.parse("2026-08-01T00:00:00.000Z");

export async function insertCanonicalUser(options: {
  id: string;
  email: string | null;
  emailVerified?: number;
  displayName?: string;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO users (id, display_name, email, email_verified, avatar_url, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)`
  )
    .bind(
      options.id,
      options.displayName ?? null,
      options.email,
      options.emailVerified ?? 0,
      SEED_NOW_MS,
      SEED_NOW_MS
    )
    .run();
}

export async function insertIdentity(options: {
  id: string;
  userId: string;
  provider: string;
  providerUserId: string;
  issuer?: string | null;
  accessToken?: string | null;
  refreshToken?: string | null;
}): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_identities (
       id, user_id, provider, provider_user_id, provider_login,
       provider_email, provider_issuer, created_at, access_token,
       refresh_token, updated_at
     ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?)`
  )
    .bind(
      options.id,
      options.userId,
      options.provider,
      options.providerUserId,
      options.issuer ?? null,
      SEED_NOW_MS,
      options.accessToken ?? null,
      options.refreshToken ?? null,
      SEED_NOW_MS
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
      SEED_NOW_MS + 7 * 24 * 60 * 60 * 1000,
      `token-${options.id}`,
      SEED_NOW_MS,
      SEED_NOW_MS,
      options.userId
    )
    .run();
}

export async function getUserRow(id: string): Promise<{
  id: string;
  display_name: string | null;
  email: string | null;
  email_verified: number;
} | null> {
  return env.DB.prepare(`SELECT id, display_name, email, email_verified FROM users WHERE id = ?`)
    .bind(id)
    .first<{
      id: string;
      display_name: string | null;
      email: string | null;
      email_verified: number;
    }>();
}

export async function getIdentityRow(
  provider: string,
  providerUserId: string
): Promise<{
  id: string;
  user_id: string;
  provider_issuer: string | null;
  access_token: string | null;
  created_at: number;
} | null> {
  return env.DB.prepare(
    `SELECT id, user_id, provider_issuer, access_token, created_at
     FROM user_identities WHERE provider = ? AND provider_user_id = ?`
  )
    .bind(provider, providerUserId)
    .first<{
      id: string;
      user_id: string;
      provider_issuer: string | null;
      access_token: string | null;
      created_at: number;
    }>();
}

export async function countTableRows(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS count FROM ${table}`).first<{
    count: number;
  }>();
  return row?.count ?? 0;
}
