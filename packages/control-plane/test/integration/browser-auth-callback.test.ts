import { createExecutionContext, env } from "cloudflare:test";
import { getSetCookies, routeRequest } from "./helpers";
import { isCanonicalUserId } from "@open-inspect/shared/user-id";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getUserAuth } from "../../src/auth/user/runtime";
import { createCloudflareEnv } from "../../src/cloudflare/platform";
import { resolveGitHubCredentialAuthority } from "../../src/source-control/github-credential-authority";
import { decryptToken } from "../../src/auth/crypto";
import { UserStore } from "../../src/db/user-store";
import { resolveGitHubEnrichmentForRequest } from "../../src/session/identity";
import { cleanD1Tables } from "./cleanup";
import { createSignedGoogleIdToken } from "./google-id-token";

const CONTROL_PLANE_ORIGIN = "https://control-plane.test.local";
const PUBLIC_WEB_ORIGIN = "https://app.test.local";
const WEB_SERVICE_SECRET = "test-service-secret-web";
const GOOGLE_CLIENT_ID = "google-client-id";
const GOOGLE_SUBJECT = "google-subject";
const MS_PER_SECOND = 1000;
const GOOGLE_ACCESS_TOKEN_LIFETIME_MS = 60 * 60 * MS_PER_SECOND;

function handleRequest(
  request: Request,
  requestEnv: Parameters<typeof routeRequest>[1]
): Promise<Response> {
  return routeRequest(request, requestEnv, createExecutionContext());
}

let googleIdToken = "";
let googlePublicKey: JsonWebKey;
let googleCertRequestCount = 0;

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
  const cookie = getSetCookies(response.headers).find((value) =>
    value.startsWith(`${cookieName}=`)
  );
  if (!cookie) throw new Error(`Missing ${cookieName} cookie`);
  return cookie.split(";", 1)[0];
}

beforeAll(async () => {
  const signedToken = await createSignedGoogleIdToken({
    audience: GOOGLE_CLIENT_ID,
    keyId: "callback-test-google-key",
    claims: {
      sub: GOOGLE_SUBJECT,
      email: "Google.User@Example.COM",
      email_verified: true,
      name: "Google User",
      picture: "https://images.example/google-user",
    },
  });
  googleIdToken = signedToken.token;
  googlePublicKey = signedToken.publicKey;

  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
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
    if (url === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(
        input instanceof Request ? await input.clone().text() : String(init?.body ?? "")
      );
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe("google-authorization-code");
      expect(body.get("client_id")).toBe(GOOGLE_CLIENT_ID);
      expect(body.get("client_secret")).toBe("google-client-secret");
      expect(body.get("redirect_uri")).toBe(`${PUBLIC_WEB_ORIGIN}/api/auth/callback/google`);
      expect(body.get("code_verifier")).toBeTruthy();
      return Response.json({
        access_token: "google-access-token",
        token_type: "Bearer",
        expires_in: GOOGLE_ACCESS_TOKEN_LIFETIME_MS / MS_PER_SECOND,
        scope: "openid email profile",
        id_token: googleIdToken,
      });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      googleCertRequestCount += 1;
      return Response.json({ keys: [googlePublicKey] });
    }
    throw new Error(`Unexpected external request: ${url}`);
  });
});

beforeEach(async () => {
  await cleanD1Tables();
  googleCertRequestCount = 0;
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("browser auth callback", () => {
  it("creates and resolves a Google browser session through an authorization-code callback", async () => {
    const initiationResponse = await handleRequest(
      await signedWebRequest("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({
          provider: "google",
          callbackURL: "/after-sign-in",
          disableRedirect: true,
        }),
      }),
      env
    );
    expect(initiationResponse.status).toBe(200);
    const providerUrl = new URL((await initiationResponse.json<{ url: string }>()).url);
    const state = providerUrl.searchParams.get("state");
    expect(state).toBeTruthy();
    expect(providerUrl.searchParams.get("code_challenge_method")).toBe("S256");
    const stateCookie = cookiePair(initiationResponse, "__Secure-openinspect.state");

    const callbackResponse = await handleRequest(
      await signedWebRequest(
        `/api/auth/callback/google?code=google-authorization-code&state=${encodeURIComponent(state ?? "")}`,
        {
          method: "GET",
          cookie: stateCookie,
        }
      ),
      env
    );

    expect(callbackResponse.status).toBe(302);
    expect(callbackResponse.headers.get("Location")).toBe("/after-sign-in");
    expect(googleCertRequestCount).toBeGreaterThan(0);
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
      user: { id: string; name: string; email: string; image: string };
      session: { id: string; userId: string };
    }>();
    expect(isCanonicalUserId(session.user.id)).toBe(true);
    expect(session).toMatchObject({
      user: {
        name: "Google User",
        email: "google.user@example.com",
        image: "https://images.example/google-user",
      },
      session: { userId: session.user.id },
    });

    await expect(
      env.DB.prepare(
        `SELECT provider_user_id, provider, user_id
         FROM user_identities
         WHERE provider = ?`
      )
        .bind("google")
        .first()
    ).resolves.toEqual({
      provider_user_id: GOOGLE_SUBJECT,
      provider: "google",
      user_id: session.user.id,
    });
    await expect(
      env.DB.prepare(
        `SELECT userId
         FROM auth_sessions
         WHERE id = ?`
      )
        .bind(session.session.id)
        .first()
    ).resolves.toEqual({ userId: session.user.id });
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
      display_name: "Google User",
      email: "google.user@example.com",
      avatar_url: "https://images.example/google-user",
    });
  });

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
      getSetCookies(callbackResponse.headers).some((cookie) =>
        cookie.startsWith("__Secure-openinspect.state=")
      )
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
       FROM user_identities
       WHERE user_id = ?`
    )
      .bind(session.user.id)
      .first<{ id: string }>();
    expect(account).not.toBeNull();
    await expect(
      env.DB.prepare(
        `SELECT r.key FROM user_role_assignments ura
         JOIN roles r ON r.id = ura.role_id WHERE ura.user_id = ?`
      )
        .bind(session.user.id)
        .first()
    ).resolves.toEqual({ key: "member" });
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM authorization_audit_events WHERE action = 'workspace.owner_bootstrapped'"
      ).first()
    ).resolves.toEqual({ count: 0 });

    const enrichment = await resolveGitHubEnrichmentForRequest(
      createCloudflareEnv(env),
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
          getUserAuth: () => getUserAuth(createCloudflareEnv(env), env.DB),
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
        `INSERT INTO user_identities (
           id, user_id, provider, provider_user_id, provider_login,
           provider_email, created_at, provider_issuer
         ) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)`
      ).bind(
        "33333333333333333333333333333333",
        canonicalUserId,
        "google",
        "google-subject",
        now.getTime(),
        "https://accounts.google.com"
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
    // The claim minted verification from the completed OAuth proof.
    expect(
      await env.DB.prepare(
        `SELECT email_verified
         FROM users
         WHERE id = ?`
      )
        .bind(canonicalUserId)
        .first<{ email_verified: number }>()
    ).toEqual({ email_verified: 1 });

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
