import { env } from "cloudflare:test";
import { BROWSER_AUTH_CLIENT_IP_HEADER } from "@open-inspect/shared/browser-auth-routes";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UserStore } from "../../src/db/user-store";
import { handleRequest } from "../../src/router";
import { cleanD1Tables } from "./cleanup";
import { createSignedGoogleIdToken } from "./google-id-token";
import {
  countTableRows,
  getAuthUserRow,
  insertAuthAccount,
  insertAuthUser,
  insertCanonicalUser,
  insertIdentity,
} from "./identity-seed-helpers";

/**
 * End-to-end sign-in flows for the canonical/auth identity reconciliation
 * design (issue #1290): the two-tier sign-in decorator (subject
 * materialization + verified-email seeding), implicit account linking, and
 * the account→user_identities projection hooks. Each test drives the real
 * OAuth callback through the worker with mocked provider endpoints and
 * asserts on both registries.
 */

const CONTROL_PLANE_ORIGIN = "https://control-plane.test.local";
const PUBLIC_WEB_ORIGIN = "https://app.test.local";
const WEB_SERVICE_SECRET = "test-service-secret-web";
const GOOGLE_CLIENT_ID = "google-client-id";
const GITHUB_SUBJECT = "583231";

let githubEmail = "octocat@example.com";
let googleIdToken = "";
let googlePublicKey: JsonWebKey;

// Better Auth rate-limits by client IP with in-memory storage that persists
// across the file's tests. Give every request a distinct IP so repeated
// sign-in flows never trip the limiter.
let clientIpCounter = 0;

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
      [BROWSER_AUTH_CLIENT_IP_HEADER]: `10.0.${Math.floor(clientIpCounter / 256)}.${clientIpCounter++ % 256}`,
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

function cookiePair(response: Response, cookieName: string): string | null {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${cookieName}=`) && !value.startsWith(`${cookieName}=;`));
  return cookie ? cookie.split(";", 1)[0] : null;
}

/**
 * Runs the full social sign-in flow (initiation + callback) and returns the
 * callback response plus the session user when a session was established.
 */
async function signIn(provider: "github" | "google"): Promise<{
  callbackResponse: Response;
  sessionUser: { id: string; email: string; name: string } | null;
}> {
  const initiationResponse = await handleRequest(
    await signedWebRequest("/api/auth/sign-in/social", {
      method: "POST",
      body: JSON.stringify({ provider, callbackURL: "/after-sign-in", disableRedirect: true }),
    }),
    env
  );
  expect(initiationResponse.status).toBe(200);
  const providerUrl = new URL((await initiationResponse.json<{ url: string }>()).url);
  const state = providerUrl.searchParams.get("state");
  const stateCookie = cookiePair(initiationResponse, "__Secure-openinspect.state");
  if (!state || !stateCookie) throw new Error("Sign-in initiation did not produce state");

  const code = provider === "google" ? "google-authorization-code" : "authorization-code";
  const callbackResponse = await handleRequest(
    await signedWebRequest(
      `/api/auth/callback/${provider}?code=${code}&state=${encodeURIComponent(state)}`,
      { method: "GET", cookie: stateCookie }
    ),
    env
  );
  expect(callbackResponse.status).toBe(302);

  const sessionCookie = cookiePair(callbackResponse, "__Secure-openinspect.session_token");
  if (!sessionCookie) return { callbackResponse, sessionUser: null };

  const sessionResponse = await handleRequest(
    await signedWebRequest("/api/auth/get-session", { method: "GET", cookie: sessionCookie }),
    env
  );
  expect(sessionResponse.status).toBe(200);
  const session = await sessionResponse.json<{
    user: { id: string; email: string; name: string } | null;
  }>();
  return { callbackResponse, sessionUser: session.user };
}

async function setGoogleClaims(claims: { sub: string; email: string; name: string }) {
  const signedToken = await createSignedGoogleIdToken({
    audience: GOOGLE_CLIENT_ID,
    keyId: "reconciliation-test-google-key",
    claims: { ...claims, email_verified: true },
  });
  googleIdToken = signedToken.token;
  googlePublicKey = signedToken.publicKey;
}

beforeAll(async () => {
  await setGoogleClaims({
    sub: "google-subject",
    email: "octocat@example.com",
    name: "Google Octocat",
  });

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
        id: Number(GITHUB_SUBJECT),
        login: "octocat",
        name: "The Octocat",
        avatar_url: "https://avatars.example/octocat",
      });
    }
    if (url.startsWith("https://api.github.com/user/emails")) {
      return Response.json([
        { email: githubEmail, primary: true, verified: true, visibility: "private" },
      ]);
    }
    if (url === "https://oauth2.googleapis.com/token") {
      return Response.json({
        access_token: "google-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "openid email profile",
        id_token: googleIdToken,
      });
    }
    if (url === "https://www.googleapis.com/oauth2/v3/certs") {
      return Response.json({ keys: [googlePublicKey] });
    }
    throw new Error(`Unexpected external request: ${url}`);
  });
});

beforeEach(async () => {
  await cleanD1Tables();
  githubEmail = "octocat@example.com";
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("verified-email tier (§4c)", () => {
  it("signs a bot-created emailed user in by seeding their auth row at sign-in (cohort 3 ongoing)", async () => {
    const canonicalId = "11111111111111111111111111111111";
    await insertCanonicalUser({
      id: canonicalId,
      email: "octocat@example.com",
      displayName: "Slack Person",
    });
    await insertIdentity({
      id: "i1111111111111111111111111111111",
      userId: canonicalId,
      provider: "slack",
      providerUserId: "U0SLACK",
    });

    const { sessionUser } = await signIn("github");

    expect(sessionUser?.id).toBe(canonicalId);
    // The email tier minted the verified auth row from the OAuth proof, then
    // Better Auth performed the implicit link itself.
    expect(await getAuthUserRow(canonicalId)).toMatchObject({
      email: "octocat@example.com",
      emailVerified: 1,
    });
    expect(
      await env.DB.prepare(
        `SELECT userId FROM auth_accounts WHERE providerId = 'github' AND accountId = ?`
      )
        .bind(GITHUB_SUBJECT)
        .first<{ userId: string }>()
    ).toEqual({ userId: canonicalId });
    // No second canonical user was registered.
    expect(await countTableRows("users")).toBe(1);
    // The forward bridge projected the new account into user_identities.
    expect(
      await env.DB.prepare(
        `SELECT user_id, provider_issuer FROM user_identities
         WHERE provider = 'github' AND provider_user_id = ?`
      )
        .bind(GITHUB_SUBJECT)
        .first<{ user_id: string; provider_issuer: string }>()
    ).toEqual({ user_id: canonicalId, provider_issuer: "https://github.com" });
  });

  it("links against a 0057-seeded reservation without re-registering (cohort 2)", async () => {
    const canonicalId = "21111111111111111111111111111111";
    await insertCanonicalUser({
      id: canonicalId,
      email: "octocat@example.com",
      displayName: "Legacy Person",
    });
    await insertAuthUser({
      id: canonicalId,
      email: "octocat@example.com",
      emailVerified: 1,
      name: "Legacy Person",
    });

    const { sessionUser } = await signIn("github");

    expect(sessionUser?.id).toBe(canonicalId);
    expect(await countTableRows("users")).toBe(1);
    expect(await countTableRows("auth_users")).toBe(1);
    // The link flow never touches the canonical row (no projection runs).
    expect(
      await env.DB.prepare(`SELECT display_name FROM users WHERE id = ?`)
        .bind(canonicalId)
        .first<{ display_name: string }>()
    ).toEqual({ display_name: "Legacy Person" });
  });

  it("repairs a stale zero-account reservation before linking (test 4a)", async () => {
    const canonicalId = "31111111111111111111111111111111";
    await insertCanonicalUser({ id: canonicalId, email: "octocat@example.com" });
    await insertAuthUser({ id: canonicalId, email: "stale@example.com", emailVerified: 0 });

    const { sessionUser } = await signIn("github");

    expect(sessionUser?.id).toBe(canonicalId);
    expect(await getAuthUserRow(canonicalId)).toMatchObject({
      email: "octocat@example.com",
      emailVerified: 1,
    });
    expect(await countTableRows("auth_users")).toBe(1);
  });

  it("never re-shapes an account-bearing auth user (email authority rule)", async () => {
    const canonicalId = "41111111111111111111111111111111";
    await insertCanonicalUser({ id: canonicalId, email: "octocat@example.com" });
    // Account-bearing but unverified: the tier must not mint verification for
    // it, so the sign-in falls through to Better Auth's own linking gate and
    // is refused.
    await insertAuthUser({ id: canonicalId, email: "octocat@example.com", emailVerified: 0 });
    await insertAuthAccount({
      id: "a4111111111111111111111111111111",
      accountId: "google-existing",
      providerId: "google",
      userId: canonicalId,
    });

    const { callbackResponse, sessionUser } = await signIn("github");

    expect(sessionUser).toBeNull();
    expect(callbackResponse.headers.get("Location")).toContain("error");
    expect(await getAuthUserRow(canonicalId)).toMatchObject({
      email: "octocat@example.com",
      emailVerified: 0,
    });
    expect(
      await env.DB.prepare(
        `SELECT id FROM auth_accounts WHERE providerId = 'github' AND accountId = ?`
      )
        .bind(GITHUB_SUBJECT)
        .first()
    ).toBeNull();
  });
});

describe("subject materialization tier (§4e)", () => {
  it("signs a GitHub-bot-created NULL-email user into their canonical id (cohort 3 NULL-email)", async () => {
    const canonicalId = "51111111111111111111111111111111";
    await insertCanonicalUser({ id: canonicalId, email: null, displayName: "GitHub Person" });
    await insertIdentity({
      id: "i5111111111111111111111111111111",
      userId: canonicalId,
      provider: "github",
      providerUserId: GITHUB_SUBJECT,
      issuer: "https://github.com",
    });

    const { sessionUser } = await signIn("github");

    expect(sessionUser?.id).toBe(canonicalId);
    // Materialization satisfied auth_users.email NOT NULL from the verified
    // sign-in email — the only moment that email exists.
    expect(await getAuthUserRow(canonicalId)).toMatchObject({
      email: "octocat@example.com",
      emailVerified: 1,
    });
    expect(
      await env.DB.prepare(
        `SELECT userId FROM auth_accounts WHERE providerId = 'github' AND accountId = ?`
      )
        .bind(GITHUB_SUBJECT)
        .first<{ userId: string }>()
    ).toEqual({ userId: canonicalId });
    // The canonical row acquired its first trustworthy email.
    expect(
      await env.DB.prepare(`SELECT email FROM users WHERE id = ?`)
        .bind(canonicalId)
        .first<{ email: string }>()
    ).toEqual({ email: "octocat@example.com" });
    expect(await countTableRows("users")).toBe(1);
  });

  it("resolves a cohort-6 collision by linking to the email owner and preserving the split (test 6)", async () => {
    // U owns the GitHub subject (bot-created, no email); V owns the verified
    // email (Slack-created).
    const subjectOwnerId = "61111111111111111111111111111111";
    const emailOwnerId = "62111111111111111111111111111111";
    await insertCanonicalUser({ id: subjectOwnerId, email: null, displayName: "GitHub Row" });
    await insertIdentity({
      id: "i6111111111111111111111111111111",
      userId: subjectOwnerId,
      provider: "github",
      providerUserId: GITHUB_SUBJECT,
      issuer: "https://github.com",
    });
    await insertCanonicalUser({
      id: emailOwnerId,
      email: "octocat@example.com",
      displayName: "Slack Row",
    });

    const { sessionUser } = await signIn("github");

    // The user signs in — onto the email owner, not the subject owner.
    expect(sessionUser?.id).toBe(emailOwnerId);
    expect(
      await env.DB.prepare(
        `SELECT userId FROM auth_accounts WHERE providerId = 'github' AND accountId = ?`
      )
        .bind(GITHUB_SUBJECT)
        .first<{ userId: string }>()
    ).toEqual({ userId: emailOwnerId });
    // The bot-era identity still points at U: an intentional, evented,
    // enumerable shared-subject split for the merge script.
    expect(
      await env.DB.prepare(
        `SELECT user_id FROM user_identities WHERE provider = 'github' AND provider_user_id = ?`
      )
        .bind(GITHUB_SUBJECT)
        .first<{ user_id: string }>()
    ).toEqual({ user_id: subjectOwnerId });
    // The R4 detection query enumerates the (U, V) pair.
    const conflicts = await env.DB.prepare(
      `SELECT i.user_id AS bot_user, a.userId AS web_user
       FROM auth_accounts a
       JOIN user_identities i
         ON i.provider = a.providerId AND i.provider_user_id = a.accountId
       WHERE a.userId <> i.user_id`
    ).all<{ bot_user: string; web_user: string }>();
    expect(conflicts.results).toEqual([{ bot_user: subjectOwnerId, web_user: emailOwnerId }]);
  });
});

describe("forward bridge and linking (§4a, §4d)", () => {
  it("projects a user_identities row for web-first registration so bot ingress resolves the same user (cohort 5)", async () => {
    const { sessionUser } = await signIn("github");
    expect(sessionUser).not.toBeNull();
    const webUserId = sessionUser?.id ?? "";

    expect(
      await env.DB.prepare(
        `SELECT user_id, provider_issuer FROM user_identities
         WHERE provider = 'github' AND provider_user_id = ?`
      )
        .bind(GITHUB_SUBJECT)
        .first<{ user_id: string; provider_issuer: string }>()
    ).toEqual({ user_id: webUserId, provider_issuer: "https://github.com" });

    // GitHub ingress attributes no email; without the projection this would
    // mint a phantom NULL-email canonical user.
    const store = new UserStore(env.DB);
    const resolved = await store.resolveOrCreateUser({
      provider: "github",
      providerUserId: GITHUB_SUBJECT,
      providerLogin: "octocat",
    });
    expect(resolved.id).toBe(webUserId);
    expect(resolved.isNew).toBe(false);
    expect(await countTableRows("users")).toBe(1);
  });

  it("auto-links a second provider with the same verified email onto one canonical user (test 10)", async () => {
    const github = await signIn("github");
    const canonicalId = github.sessionUser?.id ?? "";
    expect(canonicalId).not.toBe("");

    const google = await signIn("google");

    expect(google.sessionUser?.id).toBe(canonicalId);
    expect(await countTableRows("auth_users")).toBe(1);
    expect(await countTableRows("users")).toBe(1);
    const accounts = await env.DB.prepare(
      `SELECT providerId, userId FROM auth_accounts ORDER BY providerId`
    ).all<{ providerId: string; userId: string }>();
    expect(accounts.results).toEqual([
      { providerId: "github", userId: canonicalId },
      { providerId: "google", userId: canonicalId },
    ]);
    // Both subjects are projected for bot ingress.
    const identities = await env.DB.prepare(
      `SELECT provider, user_id FROM user_identities ORDER BY provider`
    ).all<{ provider: string; user_id: string }>();
    expect(identities.results).toEqual([
      { provider: "github", user_id: canonicalId },
      { provider: "google", user_id: canonicalId },
    ]);
  });

  it("re-projects a deleted identity on the next sign-in via the account update hook (test 9a)", async () => {
    const first = await signIn("github");
    const canonicalId = first.sessionUser?.id ?? "";
    await env.DB.prepare(`DELETE FROM user_identities WHERE provider = 'github'`).run();

    const second = await signIn("github");

    expect(second.sessionUser?.id).toBe(canonicalId);
    expect(
      await env.DB.prepare(
        `SELECT user_id FROM user_identities WHERE provider = 'github' AND provider_user_id = ?`
      )
        .bind(GITHUB_SUBJECT)
        .first<{ user_id: string }>()
    ).toEqual({ user_id: canonicalId });
  });

  it("leaves fully-linked users on an untouched fast path (test 12)", async () => {
    const first = await signIn("github");
    const canonicalId = first.sessionUser?.id ?? "";
    const snapshot = {
      users: await countTableRows("users"),
      authUsers: await countTableRows("auth_users"),
      accounts: await countTableRows("auth_accounts"),
      identities: await countTableRows("user_identities"),
    };

    const second = await signIn("github");

    expect(second.sessionUser?.id).toBe(canonicalId);
    expect({
      users: await countTableRows("users"),
      authUsers: await countTableRows("auth_users"),
      accounts: await countTableRows("auth_accounts"),
      identities: await countTableRows("user_identities"),
    }).toEqual(snapshot);
  });
});
