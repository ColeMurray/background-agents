import { getCookies } from "better-auth/cookies";
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
  suspendedAt?: number;
}

/** A cookie in Playwright storage-state form. */
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

export interface BrowserStorageState {
  cookies: BrowserCookie[];
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/** Test-only canonical bootstrap. Existing users keep their current authorization state. */
export async function seedBrowserSession(
  database: SqlDatabase,
  auth: BrowserAuth,
  seed: BrowserSessionSeed
): Promise<{ cookieHeader: string; storageState: BrowserStorageState }> {
  const existing = await database
    .prepare("SELECT id FROM users WHERE id = ?")
    .bind(seed.userId)
    .first();
  await database.batch([
    database
      .prepare(
        `INSERT OR IGNORE INTO users
      (id, display_name, email, email_verified, created_at, updated_at, suspended_at)
      VALUES (?, ?, ?, 1, ?, ?, ?)`
      )
      .bind(seed.userId, seed.name, seed.email, seed.nowMs, seed.nowMs, seed.suspendedAt ?? null),
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
): Promise<{ cookieHeader: string; storageState: BrowserStorageState }> {
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
): Promise<{ cookieHeader: string; storageState: BrowserStorageState }> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(auth.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(session.token))
  );
  const cookie = browserCookie(
    database,
    auth,
    encodeURIComponent(`${session.token}.${btoa(String.fromCharCode(...signature))}`),
    session.expiresAtMs
  );
  return {
    cookieHeader: `${cookie.name}=${cookie.value}`,
    storageState: { cookies: [cookie], origins: [] },
  };
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
