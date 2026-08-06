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
 * their own epoch-ms tables.
 */
const EXPECTED_COLUMNS: Record<string, [string, string][]> = {
  users: [
    ["id", "TEXT"],
    ["display_name", "TEXT"],
    ["email", "TEXT"],
    ["avatar_url", "TEXT"],
    ["created_at", "INTEGER"],
    ["updated_at", "INTEGER"],
    ["email_verified", "INTEGER"],
  ],
  auth_sessions: [
    ["id", "TEXT"],
    ["expiresAt", "INTEGER"],
    ["token", "TEXT"],
    ["createdAt", "INTEGER"],
    ["updatedAt", "INTEGER"],
    ["ipAddress", "TEXT"],
    ["userAgent", "TEXT"],
    ["userId", "TEXT"],
  ],
  auth_verifications: [
    ["id", "TEXT"],
    ["identifier", "TEXT"],
    ["value", "TEXT"],
    ["expiresAt", "INTEGER"],
    ["createdAt", "INTEGER"],
    ["updatedAt", "INTEGER"],
  ],
};

const EXPECTED_IDENTITY_CREDENTIAL_COLUMNS = [
  "access_token",
  "refresh_token",
  "id_token",
  "access_token_expires_at",
  "refresh_token_expires_at",
  "scope",
  "password",
  "updated_at",
];

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
      }>();
      expect(columns.results.map(({ name, type }) => [name, type])).toEqual(expectedColumns);
    }
    const identityColumns = await env.DB.prepare(`PRAGMA table_info(user_identities)`).all<{
      name: string;
    }>();
    const names = identityColumns.results.map((column) => column.name);
    for (const column of EXPECTED_IDENTITY_CREDENTIAL_COLUMNS) {
      expect(names).toContain(column);
    }

    // The account model's unique subject key — what lets identities serve as
    // Better Auth accounts at all.
    const providerIdentityIndex = await env.DB.prepare(
      `SELECT "unique"
       FROM pragma_index_list('user_identities')
       WHERE name = 'idx_user_identities_provider'`
    ).first<{ unique: number }>();
    expect(providerIdentityIndex?.unique).toBe(1);
    // The parallel registry is gone.
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
    expect(generateId({ model: "user" })).toMatch(/^[a-f0-9]{32}$/);
    expect(auth.options.session?.expiresIn).toBe(SESSION_EXPIRES_IN_MS / MS_PER_SECOND);
    expect(auth.options.session?.updateAge).toBe(SESSION_UPDATE_AGE_MS / MS_PER_SECOND);
  });
});
