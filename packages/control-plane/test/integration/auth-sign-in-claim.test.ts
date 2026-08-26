import { createExecutionContext, env } from "cloudflare:test";
import { BROWSER_AUTH_CLIENT_IP_HEADER } from "@open-inspect/shared/browser-auth-routes";
import { buildServiceAuthHeaders } from "@open-inspect/shared/service-auth";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UserStore } from "../../src/db/user-store";
import { handleRequest as routeRequest } from "../../src/router";
import { cleanD1Tables } from "./cleanup";
import { createSignedGoogleIdToken } from "./google-id-token";
import {
  countTableRows,
  getIdentityRow,
  getUserRow,
  insertCanonicalUser,
  insertIdentity,
} from "./identity-seed-helpers";

/**
 * End-to-end sign-in flows over the consolidated identity registry (issue
 * #1290): Better Auth persists directly into canonical users/user_identities
 * through the custom adapter, and the claim decorator fills NULL emails /
 * mints verification from OAuth proof. Each test drives the real OAuth
 * callback through the worker with mocked provider endpoints.
 */

const CONTROL_PLANE_ORIGIN = "https://control-plane.test.local";

function handleRequest(
  request: Request,
  requestEnv: Parameters<typeof routeRequest>[1]
): Promise<Response> {
  return routeRequest(request, requestEnv, createExecutionContext());
}
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
    keyId: "claim-test-google-key",
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

describe("email claim (bot-first users with an attributed email)", () => {
  it("signs a Slack-created user in via implicit linking after minting verification from OAuth proof", async () => {
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
    // The claim verified the attributed email from the completed OAuth proof
    // and Better Auth linked the new GitHub identity onto the same row.
    expect(await getUserRow(canonicalId)).toMatchObject({
      email: "octocat@example.com",
      email_verified: 1,
    });
    expect(await getIdentityRow("github", GITHUB_SUBJECT)).toMatchObject({
      user_id: canonicalId,
      provider_issuer: "https://github.com",
    });
    // No second canonical user was registered.
    expect(await countTableRows("users")).toBe(1);
  });

  it("heals an unverified email owner that already has identities from other providers", async () => {
    // Bot-created user with a Google identity and an attributed (unproven)
    // email. The incoming GitHub sign-in proves exactly that email, so the
    // claim mints verification and the linking gate admits the link instead
    // of refusing the sign-in ("unable to link account").
    const canonicalId = "21111111111111111111111111111111";
    await insertCanonicalUser({ id: canonicalId, email: "octocat@example.com" });
    await insertIdentity({
      id: "i2111111111111111111111111111111",
      userId: canonicalId,
      provider: "google",
      providerUserId: "google-existing",
      issuer: "https://accounts.google.com",
    });

    const { sessionUser } = await signIn("github");

    expect(sessionUser?.id).toBe(canonicalId);
    expect(await getUserRow(canonicalId)).toMatchObject({ email_verified: 1 });
    expect(await getIdentityRow("github", GITHUB_SUBJECT)).toMatchObject({
      user_id: canonicalId,
    });
    expect(await countTableRows("users")).toBe(1);
  });

  it("normalizes a legacy unnormalized email instead of registering a duplicate", async () => {
    const canonicalId = "31111111111111111111111111111111";
    await env.DB.prepare(
      `INSERT INTO users (id, email, email_verified, created_at, updated_at)
       VALUES (?, ' Octocat@Example.COM ', 0, 1, 1)`
    )
      .bind(canonicalId)
      .run();

    const { sessionUser } = await signIn("github");

    expect(sessionUser?.id).toBe(canonicalId);
    expect(await getUserRow(canonicalId)).toMatchObject({
      email: "octocat@example.com",
      email_verified: 1,
    });
    expect(await countTableRows("users")).toBe(1);
  });

  it("signs a pre-verified user in without reshaping their canonical row", async () => {
    const canonicalId = "41111111111111111111111111111111";
    await insertCanonicalUser({
      id: canonicalId,
      email: "octocat@example.com",
      emailVerified: 1,
      displayName: "Legacy Person",
    });

    const { sessionUser } = await signIn("github");

    expect(sessionUser?.id).toBe(canonicalId);
    expect(await countTableRows("users")).toBe(1);
    expect(await getUserRow(canonicalId)).toMatchObject({ display_name: "Legacy Person" });
  });
});

describe("subject claim (bot-first identities are accounts)", () => {
  it("signs a GitHub-bot-created NULL-email user straight into their canonical id", async () => {
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

    // The identity IS the account: Better Auth's account-first lookup lands
    // directly on the canonical row.
    expect(sessionUser?.id).toBe(canonicalId);
    // The claim backfilled the first trustworthy email.
    expect(await getUserRow(canonicalId)).toMatchObject({
      email: "octocat@example.com",
      email_verified: 1,
    });
    expect(await countTableRows("users")).toBe(1);
  });

  it("preserves a divergent multi-surface split and signs into the subject owner", async () => {
    // U owns the GitHub subject (bot-created, no email); V owns the verified
    // email (Slack-created). Account-first wins: the user lands on the row
    // that owns their subject and history. The email stays with V; the pair
    // is evented (auth.subject_email_collision) as merge work.
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

    expect(sessionUser?.id).toBe(subjectOwnerId);
    // No email theft: the subject owner stays NULL-email, the email owner is
    // untouched, and both rows survive for the merge script.
    expect(await getUserRow(subjectOwnerId)).toMatchObject({ email: null });
    expect(await getUserRow(emailOwnerId)).toMatchObject({ email: "octocat@example.com" });
    expect(await getIdentityRow("github", GITHUB_SUBJECT)).toMatchObject({
      user_id: subjectOwnerId,
    });
    expect(await countTableRows("users")).toBe(2);
  });
});

describe("register, linking, and steady state", () => {
  it("registers a web-first user directly into the canonical registry (no phantom split)", async () => {
    const { sessionUser } = await signIn("github");
    expect(sessionUser).not.toBeNull();
    const webUserId = sessionUser?.id ?? "";

    const identity = await getIdentityRow("github", GITHUB_SUBJECT);
    expect(identity).toMatchObject({
      user_id: webUserId,
      provider_issuer: "https://github.com",
    });
    expect(await getUserRow(webUserId)).toMatchObject({
      email: "octocat@example.com",
      email_verified: 1,
    });

    // GitHub ingress attributes no email; the shared identity row means bot
    // resolution finds the same user instead of minting a phantom.
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

  it("auto-links a second provider with the same verified email onto one canonical user", async () => {
    const github = await signIn("github");
    const canonicalId = github.sessionUser?.id ?? "";
    expect(canonicalId).not.toBe("");

    const google = await signIn("google");

    expect(google.sessionUser?.id).toBe(canonicalId);
    expect(await countTableRows("users")).toBe(1);
    const identities = await env.DB.prepare(
      `SELECT provider, user_id FROM user_identities ORDER BY provider`
    ).all<{ provider: string; user_id: string }>();
    expect(identities.results).toEqual([
      { provider: "github", user_id: canonicalId },
      { provider: "google", user_id: canonicalId },
    ]);
  });

  it("re-links a deleted identity on the next sign-in through the email fallback", async () => {
    const first = await signIn("github");
    const canonicalId = first.sessionUser?.id ?? "";
    await env.DB.prepare(`DELETE FROM user_identities WHERE provider = 'github'`).run();

    const second = await signIn("github");

    expect(second.sessionUser?.id).toBe(canonicalId);
    expect(await getIdentityRow("github", GITHUB_SUBJECT)).toMatchObject({
      user_id: canonicalId,
    });
    expect(await countTableRows("users")).toBe(1);
  });

  it("keeps repeat sign-ins row-stable", async () => {
    const first = await signIn("github");
    const canonicalId = first.sessionUser?.id ?? "";
    const snapshot = {
      users: await countTableRows("users"),
      identities: await countTableRows("user_identities"),
    };

    const second = await signIn("github");

    expect(second.sessionUser?.id).toBe(canonicalId);
    expect({
      users: await countTableRows("users"),
      identities: await countTableRows("user_identities"),
    }).toEqual(snapshot);
  });

  it("stores refreshed OAuth credentials on the identity row (live credential store)", async () => {
    const { sessionUser } = await signIn("github");
    const identity = await getIdentityRow("github", GITHUB_SUBJECT);
    expect(identity?.user_id).toBe(sessionUser?.id);
    // encryptOAuthTokens: the adapter stores ciphertext, never the raw token.
    expect(identity?.access_token).not.toBeNull();
    expect(identity?.access_token).not.toBe("github-access-token");
  });
});
