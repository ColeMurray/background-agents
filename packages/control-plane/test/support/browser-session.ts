import { getCookies } from "better-auth/cookies";
import { BUILT_IN_ROLE_REGISTRY, type BuiltInRoleKey } from "@open-inspect/shared/rbac";
import { createUserAuth } from "../../src/auth/user/better-auth";
import type { SqlDatabase } from "../../src/db/sql-database";

export interface BrowserSessionSeed {
  userId: string;
  identityId: string;
  providerSubject: string;
  name: string;
  email: string;
  role: BuiltInRoleKey;
  suspendedAt?: number;
  sessionId: string;
  token: string;
  expiresAtMs: number;
  nowMs: number;
}

export interface BrowserStorageState {
  cookies: Array<{
    name: string;
    value: string;
    domain: string;
    path: string;
    expires: number;
    httpOnly: boolean;
    secure: boolean;
    sameSite: "Lax" | "Strict" | "None";
  }>;
  origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
}

/** Test-only canonical bootstrap. Existing users keep their current authorization state. */
export async function seedBrowserSession(
  database: SqlDatabase,
  auth: { publicWebOrigin: string; secret: string },
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
    database
      .prepare(
        `INSERT OR IGNORE INTO auth_sessions
      (id, expiresAt, token, createdAt, updatedAt, ipAddress, userAgent, userId)
      VALUES (?, ?, ?, ?, ?, '127.0.0.1', 'authenticated-preview', ?)`
      )
      .bind(seed.sessionId, seed.expiresAtMs, seed.token, seed.nowMs, seed.nowMs, seed.userId),
    ...(!existing
      ? [
          database
            .prepare("UPDATE user_role_assignments SET role_id = ? WHERE user_id = ?")
            .bind(BUILT_IN_ROLE_REGISTRY[seed.role].id, seed.userId),
        ]
      : []),
  ]);

  // Use the production authority's actual options, not a second cookie policy.
  const options = createUserAuth({ database, ...auth }).options;
  const { name, attributes } = getCookies(options).sessionToken;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(auth.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(seed.token))
  );
  const value = encodeURIComponent(`${seed.token}.${btoa(String.fromCharCode(...signature))}`);
  const sameSite =
    attributes.sameSite === "strict" ? "Strict" : attributes.sameSite === "none" ? "None" : "Lax";
  return {
    cookieHeader: `${name}=${value}`,
    storageState: {
      cookies: [
        {
          name,
          value,
          domain: new URL(auth.publicWebOrigin).hostname,
          path: attributes.path ?? "/",
          expires: Math.floor(seed.expiresAtMs / 1000),
          httpOnly: attributes.httpOnly ?? true,
          secure: attributes.secure ?? false,
          sameSite,
        },
      ],
      origins: [],
    },
  };
}
