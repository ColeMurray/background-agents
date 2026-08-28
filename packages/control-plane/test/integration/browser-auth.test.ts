import { env } from "cloudflare:test";
import { BROWSER_AUTH_CLIENT_IP_HEADER } from "@open-inspect/shared/browser-auth-routes";
import { verifyGoogleIdToken } from "better-auth/social-providers";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_EXPIRES_IN_MS,
  SESSION_UPDATE_AGE_MS,
  createUserAuth,
} from "../../src/auth/user/better-auth";
import { createSignedGoogleIdToken } from "./google-id-token";

const PUBLIC_WEB_ORIGIN = "https://web.test.local";
const SECRET = "test-only-better-auth-secret-with-at-least-32-characters";
const MS_PER_SECOND = 1000;
const UNUSED_PROFILE_RESOLVER = async () => null;

/**
 * Post-consolidation shapes the adapter's field maps depend on: Better Auth's
 * user/account models live in the canonical tables, sessions/verifications in
 * their own epoch-ms tables. Tuples are [name, type, notnull, pk] from
 * PRAGMA table_info — the full column contract, not just names.
 */
const EXPECTED_COLUMNS: Record<string, [string, string, number, number][]> = {
  users: [
    ["id", "TEXT", 0, 1],
    ["display_name", "TEXT", 0, 0],
    ["email", "TEXT", 0, 0],
    ["avatar_url", "TEXT", 0, 0],
    ["created_at", "INTEGER", 1, 0],
    ["updated_at", "INTEGER", 1, 0],
    ["email_verified", "INTEGER", 1, 0],
  ],
  user_identities: [
    ["id", "TEXT", 0, 1],
    ["user_id", "TEXT", 1, 0],
    ["provider", "TEXT", 1, 0],
    ["provider_user_id", "TEXT", 1, 0],
    ["provider_login", "TEXT", 0, 0],
    ["provider_email", "TEXT", 0, 0],
    ["created_at", "INTEGER", 1, 0],
    ["provider_issuer", "TEXT", 0, 0],
    ["access_token", "TEXT", 0, 0],
    ["refresh_token", "TEXT", 0, 0],
    ["id_token", "TEXT", 0, 0],
    ["access_token_expires_at", "INTEGER", 0, 0],
    ["refresh_token_expires_at", "INTEGER", 0, 0],
    ["scope", "TEXT", 0, 0],
    ["password", "TEXT", 0, 0],
    ["updated_at", "INTEGER", 0, 0],
  ],
  auth_sessions: [
    ["id", "TEXT", 1, 1],
    ["expiresAt", "INTEGER", 1, 0],
    ["token", "TEXT", 1, 0],
    ["createdAt", "INTEGER", 1, 0],
    ["updatedAt", "INTEGER", 1, 0],
    ["ipAddress", "TEXT", 0, 0],
    ["userAgent", "TEXT", 0, 0],
    ["userId", "TEXT", 1, 0],
  ],
  auth_verifications: [
    ["id", "TEXT", 1, 1],
    ["identifier", "TEXT", 1, 0],
    ["value", "TEXT", 1, 0],
    ["expiresAt", "INTEGER", 1, 0],
    ["createdAt", "INTEGER", 1, 0],
    ["updatedAt", "INTEGER", 1, 0],
  ],
};

function createTestAuth() {
  return createUserAuth({
    database: env.DB,
    publicWebOrigin: PUBLIC_WEB_ORIGIN,
    secret: SECRET,
  });
}

describe("browser authentication", () => {
  it("keeps the consolidated schema aligned with the adapter's field maps", async () => {
    for (const [table, expectedColumns] of Object.entries(EXPECTED_COLUMNS)) {
      const columns = await env.DB.prepare(`PRAGMA table_info(${table})`).all<{
        name: string;
        type: string;
        notnull: number;
        pk: number;
      }>();
      expect(
        columns.results.map(({ name, type, notnull, pk }) => [name, type, notnull, pk])
      ).toEqual(expectedColumns);
    }

    // The account model's unique subject key — what lets identities serve as
    // Better Auth accounts at all.
    const providerIdentityIndex = await env.DB.prepare(
      `SELECT "unique"
       FROM pragma_index_list('user_identities')
       WHERE name = 'idx_user_identities_provider'`
    ).first<{ unique: number }>();
    expect(providerIdentityIndex?.unique).toBe(1);
    // The email-linking key: unique over non-NULL emails only (bot-created
    // users may have no email).
    const emailIndex = await env.DB.prepare(
      `SELECT "unique", partial
       FROM pragma_index_list('users')
       WHERE name = 'idx_users_email'`
    ).first<{ unique: number; partial: number }>();
    expect(emailIndex).toEqual({ unique: 1, partial: 1 });
    // Session tokens are the bearer credential — must be unique.
    const tokenUnique = await env.DB.prepare(
      `SELECT COUNT(*) AS count
       FROM pragma_index_list('auth_sessions') AS il
       JOIN pragma_index_info(il.name) AS ii
       WHERE il."unique" = 1 AND ii.name = 'token'`
    ).first<{ count: number }>();
    expect(tokenUnique?.count).toBe(1);
    // Foreign keys target canonical users; deleting a user cascades their
    // browser sessions but never silently drops identities.
    const sessionForeignKeys = await env.DB.prepare(
      `SELECT "table" AS target, "from" AS source_column, "to" AS target_column, on_delete
       FROM pragma_foreign_key_list('auth_sessions')`
    ).all();
    expect(sessionForeignKeys.results).toEqual([
      { target: "users", source_column: "userId", target_column: "id", on_delete: "CASCADE" },
    ]);
    const identityForeignKeys = await env.DB.prepare(
      `SELECT "table" AS target, "from" AS source_column, "to" AS target_column, on_delete
       FROM pragma_foreign_key_list('user_identities')`
    ).all();
    expect(identityForeignKeys.results).toEqual([
      { target: "users", source_column: "user_id", target_column: "id", on_delete: "NO ACTION" },
    ]);
    // The pre-consolidation Better Auth tables must stay gone: their
    // reappearance would mean sign-ins writing outside the canonical
    // registry again (migration 0057 dropped them).
    const legacyTables = await env.DB.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('auth_users', 'auth_accounts')`
    ).all();
    expect(legacyTables.results).toEqual([]);
  });

  it("serves an anonymous session through Better Auth on Workers and D1", async () => {
    const auth = createTestAuth();
    const response = await auth.handler(new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/get-session`));

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
  });

  it("initiates GitHub App sign-in with PKCE and no classic OAuth scopes", async () => {
    const auth = createUserAuth({
      database: env.DB,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
      github: {
        clientId: "github-app-client-id",
        clientSecret: "github-app-client-secret",
        getUserInfo: UNUSED_PROFILE_RESOLVER,
      },
    });

    const response = await auth.handler(
      new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: PUBLIC_WEB_ORIGIN,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/",
          disableRedirect: true,
        }),
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ redirect: boolean; url: string }>();
    const providerUrl = new URL(body.url);
    expect(body.redirect).toBe(false);
    expect(providerUrl.origin).toBe("https://github.com");
    expect(providerUrl.pathname).toBe("/login/oauth/authorize");
    expect(providerUrl.searchParams.get("client_id")).toBe("github-app-client-id");
    expect(providerUrl.searchParams.get("redirect_uri")).toBe(
      `${PUBLIC_WEB_ORIGIN}/api/auth/callback/github`
    );
    expect(providerUrl.searchParams.get("scope")).toBe("");
    expect(providerUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(providerUrl.searchParams.get("state")).toBeTruthy();

    const stateCookie = response.headers.get("set-cookie");
    expect(stateCookie).toContain("__Secure-openinspect.state=");
    expect(stateCookie?.toLowerCase()).toContain("httponly");
    expect(stateCookie?.toLowerCase()).toContain("secure");
    expect(stateCookie?.toLowerCase()).toContain("samesite=lax");
    expect(stateCookie?.toLowerCase()).not.toContain("domain=");
  });

  it("rejects social sign-in from an untrusted browser origin", async () => {
    const auth = createUserAuth({
      database: env.DB,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
      github: {
        clientId: "github-app-client-id",
        clientSecret: "github-app-client-secret",
        getUserInfo: UNUSED_PROFILE_RESOLVER,
      },
    });

    const response = await auth.handler(
      new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          [BROWSER_AUTH_CLIENT_IP_HEADER]: "203.0.113.74",
          "Content-Type": "application/json",
          Cookie: "__Secure-openinspect.session_token=invalid",
          Origin: "https://attacker.example",
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/",
          disableRedirect: true,
        }),
      })
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("rate limits repeated browser sign-in attempts by the trusted client IP", async () => {
    const auth = createUserAuth({
      database: env.DB,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
      github: {
        clientId: "github-app-client-id",
        clientSecret: "github-app-client-secret",
        getUserInfo: UNUSED_PROFILE_RESOLVER,
      },
    });
    const signIn = () =>
      auth.handler(
        new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/sign-in/social`, {
          method: "POST",
          headers: {
            [BROWSER_AUTH_CLIENT_IP_HEADER]: "203.0.113.73",
            "Content-Type": "application/json",
            Origin: PUBLIC_WEB_ORIGIN,
          },
          body: JSON.stringify({
            provider: "github",
            callbackURL: "/",
            disableRedirect: true,
          }),
        })
      );

    await expect(signIn()).resolves.toMatchObject({ status: 200 });
    await expect(signIn()).resolves.toMatchObject({ status: 200 });
    await expect(signIn()).resolves.toMatchObject({ status: 200 });

    const limited = await signIn();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("X-Retry-After")).toBeTruthy();
  });

  it("uses a non-Secure host-only cookie only for loopback HTTP development", async () => {
    const localOrigin = "http://localhost:3000";
    const auth = createUserAuth({
      database: env.DB,
      publicWebOrigin: localOrigin,
      secret: SECRET,
      github: {
        clientId: "github-app-client-id",
        clientSecret: "github-app-client-secret",
        getUserInfo: UNUSED_PROFILE_RESOLVER,
      },
    });

    const response = await auth.handler(
      new Request(`${localOrigin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: localOrigin,
        },
        body: JSON.stringify({
          provider: "github",
          callbackURL: "/",
          disableRedirect: true,
        }),
      })
    );

    expect(response.status).toBe(200);
    const stateCookie = response.headers.get("set-cookie");
    expect(stateCookie).toContain("openinspect.state=");
    expect(stateCookie).not.toContain("__Secure-");
    expect(stateCookie?.toLowerCase()).not.toContain("; secure");
    expect(stateCookie?.toLowerCase()).toContain("httponly");
  });

  it("initiates Google OIDC sign-in with PKCE and minimum identity scopes", async () => {
    const auth = createUserAuth({
      database: env.DB,
      publicWebOrigin: PUBLIC_WEB_ORIGIN,
      secret: SECRET,
      google: {
        clientId: "google-client-id",
        clientSecret: "google-client-secret",
        getUserInfo: UNUSED_PROFILE_RESOLVER,
      },
    });

    const response = await auth.handler(
      new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: PUBLIC_WEB_ORIGIN,
        },
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/",
          disableRedirect: true,
        }),
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ redirect: boolean; url: string }>();
    const providerUrl = new URL(body.url);
    expect(body.redirect).toBe(false);
    expect(providerUrl.origin).toBe("https://accounts.google.com");
    expect(providerUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(providerUrl.searchParams.get("client_id")).toBe("google-client-id");
    expect(providerUrl.searchParams.get("redirect_uri")).toBe(
      `${PUBLIC_WEB_ORIGIN}/api/auth/callback/google`
    );
    expect(new Set(providerUrl.searchParams.get("scope")?.split(" "))).toEqual(
      new Set(["email", "openid", "profile"])
    );
    expect(providerUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(providerUrl.searchParams.get("state")).toBeTruthy();
  });

  it("rejects direct Google ID-token sign-in without creating authentication state", async () => {
    const clientId = "google-client-id";
    const { token, publicKey } = await createSignedGoogleIdToken({
      audience: clientId,
      claims: {
        sub: "direct-id-token-subject",
        email: "direct-id-token@example.com",
        email_verified: true,
        name: "Direct ID Token User",
      },
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url === "https://www.googleapis.com/oauth2/v3/certs") {
        return Response.json({ keys: [publicKey] });
      }
      throw new Error(`Unexpected external request: ${url}`);
    });

    try {
      await expect(verifyGoogleIdToken({ token, audience: clientId })).resolves.toMatchObject({
        sub: "direct-id-token-subject",
      });

      const auth = createUserAuth({
        database: env.DB,
        publicWebOrigin: PUBLIC_WEB_ORIGIN,
        secret: SECRET,
        google: {
          clientId,
          clientSecret: "google-client-secret",
          getUserInfo: async () => ({
            user: {
              id: "direct-id-token-subject",
              name: "Direct ID Token User",
              email: "direct-id-token@example.com",
              emailVerified: true,
            },
            data: null,
          }),
        },
      });

      const response = await auth.handler(
        new Request(`${PUBLIC_WEB_ORIGIN}/api/auth/sign-in/social`, {
          method: "POST",
          headers: {
            [BROWSER_AUTH_CLIENT_IP_HEADER]: "203.0.113.75",
            "Content-Type": "application/json",
            Origin: PUBLIC_WEB_ORIGIN,
          },
          body: JSON.stringify({
            provider: "google",
            callbackURL: "/",
            idToken: { token },
          }),
        })
      );

      expect(response.status).toBe(401);
      expect(response.headers.get("set-cookie")).toBeNull();
      const sessionCount = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM auth_sessions"
      ).first<{ count: number }>();
      expect(sessionCount?.count).toBe(0);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("uses canonical ids and converts millisecond durations at the library boundary", () => {
    const auth = createTestAuth();
    const generateId = auth.options.advanced?.database?.generateId;

    expect(generateId).toBeTypeOf("function");
    if (typeof generateId !== "function") {
      throw new Error("Better Auth canonical ID generator is not configured");
    }
    expect(generateId()).toMatch(/^[a-f0-9]{32}$/);
    expect(auth.options.session?.expiresIn).toBe(SESSION_EXPIRES_IN_MS / MS_PER_SECOND);
    expect(auth.options.session?.updateAge).toBe(SESSION_UPDATE_AGE_MS / MS_PER_SECOND);
  });
});
