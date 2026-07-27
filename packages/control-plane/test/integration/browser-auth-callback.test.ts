import { env } from "cloudflare:test";
import { buildServiceAuthHeaders, isCanonicalUserId } from "@open-inspect/shared";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserAuth } from "../../src/auth/user/runtime";
import { resolveGitHubCredentialAuthority } from "../../src/source-control/github-credential-authority";
import { decryptToken } from "../../src/auth/crypto";
import { UserStore } from "../../src/db/user-store";
import { handleRequest } from "../../src/router";
import { resolveGitHubEnrichmentForRequest } from "../../src/session/identity";
import { cleanD1Tables } from "./cleanup";

const CONTROL_PLANE_ORIGIN = "https://control-plane.test.local";
const PUBLIC_WEB_ORIGIN = "https://app.test.local";
const WEB_SERVICE_SECRET = "test-service-secret-web";

async function signedWebRequest(
  path: string,
  init: {
    method: "GET" | "POST";
    body?: string;
    cookie?: string;
  }
): Promise<Request> {
  const url = `${CONTROL_PLANE_ORIGIN}${path}`;
  return new Request(url, {
    method: init.method,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.cookie ? { Cookie: init.cookie } : {}),
      Origin: PUBLIC_WEB_ORIGIN,
      ...(await buildServiceAuthHeaders({
        service: "web",
        secret: WEB_SERVICE_SECRET,
        method: init.method,
        url,
        body: init.body,
      })),
    },
    body: init.body,
  });
}

function cookiePair(response: Response, cookieName: string): string {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${cookieName}=`));
  if (!cookie) throw new Error(`Missing ${cookieName} cookie`);
  return cookie.split(";", 1)[0];
}

beforeAll(() => {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({
        access_token: "github-access-token",
        token_type: "bearer",
        expires_in: 28_800,
        refresh_token: "github-refresh-token",
        refresh_token_expires_in: 15_897_600,
      });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({
        id: 583_231,
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.example/octocat",
      });
    }
    if (url.startsWith("https://api.github.com/user/emails")) {
      return Response.json([
        {
          email: "octocat@example.com",
          primary: true,
          verified: true,
          visibility: "private",
        },
      ]);
    }
    throw new Error(`Unexpected external request: ${url}`);
  });
});

beforeEach(cleanD1Tables);

afterAll(() => {
  vi.restoreAllMocks();
});

describe("browser auth callback", () => {
  it("creates and resolves a GitHub browser session through the signed proxy", async () => {
    const initiationBody = JSON.stringify({
      provider: "github",
      callbackURL: "/after-sign-in",
      disableRedirect: true,
    });
    const initiationResponse = await handleRequest(
      await signedWebRequest("/api/auth/sign-in/social", {
        method: "POST",
        body: initiationBody,
      }),
      env
    );
    expect(initiationResponse.status).toBe(200);
    const providerUrl = new URL((await initiationResponse.json<{ url: string }>()).url);
    const state = providerUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    const stateCookie = cookiePair(initiationResponse, "__Secure-openinspect.state");

    const callbackResponse = await handleRequest(
      await signedWebRequest(
        `/api/auth/callback/github?code=authorization-code&state=${encodeURIComponent(state ?? "")}`,
        {
          method: "GET",
          cookie: stateCookie,
        }
      ),
      env
    );

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("Location")).toBe("/after-sign-in");
    expect(
      callbackResponse.headers
        .getSetCookie()
        .some((cookie) => cookie.startsWith("__Secure-openinspect.state="))
    ).toBe(true);
    const sessionCookie = cookiePair(callbackResponse, "__Secure-openinspect.session_token");

    const sessionResponse = await handleRequest(
      await signedWebRequest("/api/auth/get-session", {
        method: "GET",
        cookie: sessionCookie,
      }),
      env
    );

    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json<{
      user: { id: string; name: string; email: string };
      session: { id: string; userId: string };
    }>();
    expect(isCanonicalUserId(session.user.id)).toBe(true);
    expect(session).toMatchObject({
      user: {
        id: expect.any(String),
        name: "The Octocat",
        email: "octocat@example.com",
      },
      session: {
        userId: expect.any(String),
      },
    });

    const account = await env.DB.prepare(
      `SELECT id
       FROM auth_accounts
       WHERE userId = ?`
    )
      .bind(session.user.id)
      .first<{ id: string }>();
    expect(account).not.toBeNull();

    const enrichment = await resolveGitHubEnrichmentForRequest(
      env,
      env.DB,
      new UserStore(env.DB),
      session.user.id,
      await resolveGitHubCredentialAuthority(
        {
          principal: { kind: "user", userId: session.user.id },
          authentication: {
            mechanism: "browser_session",
            credentialId: session.session.id,
            channel: { kind: "sig1", service: "web" },
          },
          getUserAuth: () => getUserAuth(env, env.DB),
        },
        new Headers({ Cookie: sessionCookie })
      )
    );
    expect(enrichment).toMatchObject({
      scmUserId: "583231",
      scmLogin: "octocat",
      email: "583231+octocat@users.noreply.github.com",
      accessTokenEncrypted: expect.any(String),
    });
    await expect(
      decryptToken(enrichment?.accessTokenEncrypted ?? "", env.TOKEN_ENCRYPTION_KEY)
    ).resolves.toBe("github-access-token");

    await expect(
      env.DB.prepare(
        `SELECT id, display_name, email, avatar_url
         FROM users
         WHERE id = ?`
      )
        .bind(session.user.id)
        .first()
    ).resolves.toEqual({
      id: session.user.id,
      display_name: "The Octocat",
      email: "octocat@example.com",
      avatar_url: "https://avatars.example/octocat",
    });

    const resourceResponse = await handleRequest(
      await signedWebRequest("/model-preferences", {
        method: "GET",
        cookie: sessionCookie,
      }),
      env
    );
    expect(resourceResponse.status).toBe(200);

    const channelOnlyResponse = await handleRequest(
      await signedWebRequest("/model-preferences", {
        method: "GET",
      }),
      env
    );
    expect(channelOnlyResponse.status).toBe(401);
  });

  it("signs an existing canonical user in through a migrated GitHub account", async () => {
    const canonicalUserId = "11111111111111111111111111111111";
    const providerIdentityId = "22222222222222222222222222222222";
    const now = new Date("2026-07-26T21:47:56.000Z");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO users (
           id, display_name, email, avatar_url, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(
        canonicalUserId,
        "Legacy User",
        "octocat@example.com",
        null,
        now.getTime(),
        now.getTime()
      ),
      env.DB.prepare(
        `INSERT INTO user_identities (
           id, user_id, provider, provider_user_id, provider_login,
           provider_email, created_at, provider_issuer
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        providerIdentityId,
        canonicalUserId,
        "github",
        "583231",
        "octocat",
        "octocat@example.com",
        now.getTime(),
        "https://github.com"
      ),
      env.DB.prepare(
        `INSERT INTO auth_users (
           id, name, email, emailVerified, image, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        canonicalUserId,
        "Legacy User",
        "octocat@example.com",
        0,
        null,
        now.toISOString(),
        now.toISOString()
      ),
      env.DB.prepare(
        `INSERT INTO auth_accounts (
           id, accountId, providerId, userId, accessToken, refreshToken,
           idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope,
           password, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      ).bind(
        providerIdentityId,
        "583231",
        "github",
        canonicalUserId,
        now.toISOString(),
        now.toISOString()
      ),
      env.DB.prepare(
        `INSERT INTO auth_accounts (
           id, accountId, providerId, userId, accessToken, refreshToken,
           idToken, accessTokenExpiresAt, refreshTokenExpiresAt, scope,
           password, createdAt, updatedAt
         ) VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`
      ).bind(
        "33333333333333333333333333333333",
        "google-subject",
        "google",
        canonicalUserId,
        now.toISOString(),
        now.toISOString()
      ),
    ]);

    const initiationBody = JSON.stringify({
      provider: "github",
      callbackURL: "/after-sign-in",
      disableRedirect: true,
    });
    const initiationResponse = await handleRequest(
      await signedWebRequest("/api/auth/sign-in/social", {
        method: "POST",
        body: initiationBody,
      }),
      env
    );
    const providerUrl = new URL((await initiationResponse.json<{ url: string }>()).url);
    const state = providerUrl.searchParams.get("state");
    const stateCookie = cookiePair(initiationResponse, "__Secure-openinspect.state");

    const callbackResponse = await handleRequest(
      await signedWebRequest(
        `/api/auth/callback/github?code=authorization-code&state=${encodeURIComponent(state ?? "")}`,
        {
          method: "GET",
          cookie: stateCookie,
        }
      ),
      env
    );

    expect(callbackResponse.status).toBe(302);
    const sessionCookie = cookiePair(callbackResponse, "__Secure-openinspect.session_token");
    const sessionResponse = await handleRequest(
      await signedWebRequest("/api/auth/get-session", {
        method: "GET",
        cookie: sessionCookie,
      }),
      env
    );
    expect(await sessionResponse.json<{ user: { id: string } }>()).toMatchObject({
      user: { id: canonicalUserId },
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
         FROM users
         WHERE email = ?`
      )
        .bind("octocat@example.com")
        .first<{ count: number }>()
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        `SELECT emailVerified
         FROM auth_users
         WHERE id = ?`
      )
        .bind(canonicalUserId)
        .first<{ emailVerified: number }>()
    ).toEqual({ emailVerified: 1 });

    const resourceResponse = await handleRequest(
      await signedWebRequest("/model-preferences", {
        method: "GET",
        cookie: sessionCookie,
      }),
      env
    );
    expect(resourceResponse.status).toBe(200);
  });
});
