import { getCookies } from "better-auth/cookies";
import { makeSignature } from "better-auth/crypto";
import { BUILT_IN_ROLE_REGISTRY, type BuiltInRoleKey } from "@open-inspect/shared/rbac";
import { createUserAuth, type UserAuthConfig } from "../../src/auth/user/better-auth";
import type { SqlDatabase } from "../../src/db/sql-database";

type BrowserAuth = Pick<UserAuthConfig, "publicWebOrigin" | "secret">;

/** One login for an existing user: the auth_sessions row a Better Auth sign-in writes. */
export interface BrowserSessionRecord {
  userId: string;
  sessionId: string;
  token: string;
  expiresAtMs: number;
  nowMs: number;
}

export interface BrowserSessionSeed extends BrowserSessionRecord {
  identityId: string;
  providerSubject: string;
  name: string;
  email: string;
  role: BuiltInRoleKey;
  avatarUrl?: string;
  suspendedAt?: number;
}

/** A login cookie with the attributes the production authority sets on it. */
export interface BrowserCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Seconds since the epoch; browsers discard a cookie whose expiry has passed. */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Lax" | "Strict" | "None";
}

/** A signed-in browser: the cookie itself and the request header that carries it. */
export interface BrowserSession {
  cookieHeader: string;
  cookie: BrowserCookie;
}

/** Test-only canonical bootstrap. Existing users keep their current authorization state. */
export async function seedBrowserSession(
  database: SqlDatabase,
  auth: BrowserAuth,
  seed: BrowserSessionSeed
): Promise<BrowserSession> {
  const existing = await database
    .prepare("SELECT id FROM users WHERE id = ?")
    .bind(seed.userId)
    .first();
  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO users
      (id, display_name, email, email_verified, avatar_url, created_at, updated_at, suspended_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?)`
      )
      .bind(
        seed.userId,
        seed.name,
        seed.email,
        seed.avatarUrl ?? null,
        seed.nowMs,
        seed.nowMs,
        seed.suspendedAt ?? null
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO user_identities
      (id, user_id, provider, provider_user_id, provider_email, provider_issuer, created_at, updated_at)
      VALUES (?, ?, 'github', ?, ?, 'https://github.com', ?, ?)`
      )
      .bind(seed.identityId, seed.userId, seed.providerSubject, seed.email, seed.nowMs, seed.nowMs),
    insertAuthSession(database, seed),
    ...(!existing
      ? [
          database
            .prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
            .bind(BUILT_IN_ROLE_REGISTRY[seed.role].id, seed.userId),
        ]
      : []),
  ]);
  return sessionCookie(database, auth, seed);
}

/**
 * Signs an existing user in again as a new session, for example after sign-out deleted the last
 * one. The user, identity and role are untouched; an unknown user fails its foreign key.
 */
export async function mintBrowserSession(
  database: SqlDatabase,
  auth: BrowserAuth,
  session: BrowserSessionRecord
): Promise<BrowserSession> {
  await insertAuthSession(database, session).run();
  return sessionCookie(database, auth, session);
}

/** The login cookie emptied and already expired: setting it signs a browser out. */
export function signedOutBrowserCookie(database: SqlDatabase, auth: BrowserAuth): BrowserCookie {
  return browserCookie(database, auth, "", 0);
}

function insertAuthSession(database: SqlDatabase, session: BrowserSessionRecord) {
  return database
    .prepare(
      `INSERT OR IGNORE INTO auth_sessions
      (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId)
      VALUES (?, ?, ?, ?, ?, '127.0.0.1', 'authenticated-preview', ?)`
    )
    .bind(
      session.sessionId,
      session.expiresAtMs,
      session.token,
      session.nowMs,
      session.nowMs,
      session.userId
    );
}

async function sessionCookie(
  database: SqlDatabase,
  auth: BrowserAuth,
  session: BrowserSessionRecord
): Promise<BrowserSession> {
  // Better Auth's own signer, so the value is exactly what its cookie reader verifies.
  const signature = await makeSignature(session.token, auth.secret);
  const cookie = browserCookie(
    database,
    auth,
    encodeURIComponent(`${session.token}.${signature}`),
    session.expiresAtMs
  );
  return { cookieHeader: `${cookie.name}=${cookie.value}`, cookie };
}

function browserCookie(
  database: SqlDatabase,
  auth: BrowserAuth,
  value: string,
  expiresAtMs: number
): BrowserCookie {
  // Use the production authority's actual options, not a second cookie policy.
  const options = createUserAuth({ database, ...auth }).options;
  const { name, attributes } = getCookies(options).sessionToken;
  const sameSite =
    attributes.sameSite === "strict" ? "Strict" : attributes.sameSite === "none" ? "None" : "Lax";
  return {
    name,
    value,
    domain: new URL(auth.publicWebOrigin).hostname,
    path: attributes.path ?? "/",
    expires: Math.floor(expiresAtMs / 1000),
    httpOnly: attributes.httpOnly ?? true,
    secure: attributes.secure ?? false,
    sameSite,
  };
}
