import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import {
  buildServiceAuthHeaders,
  generateInternalToken,
  type ServiceName,
} from "@open-inspect/shared";
import {
  ApiTokenStore,
  EXPIRED_TOKEN_RETENTION_MS,
  type NewApiToken,
} from "../../src/db/api-tokens";
import { REFRESH_REUSE_GRACE_MS } from "../../src/auth/web-session-tokens";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";

const originalFetch = globalThis.fetch;

interface ProviderMockState {
  githubUserStatus: number;
  githubEmailsStatus: number;
  githubEmailsBody: unknown;
  googleStatus: number;
}

const providerMock: ProviderMockState = {
  githubUserStatus: 200,
  githubEmailsStatus: 200,
  githubEmailsBody: [{ email: "octocat@example.com", primary: true, verified: true }],
  googleStatus: 200,
};

function installProviderFetchMock(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "https://api.github.com/user") {
        if (providerMock.githubUserStatus !== 200) {
          return Response.json({ message: "nope" }, { status: providerMock.githubUserStatus });
        }
        return Response.json({
          id: 583231,
          login: "octocat",
          // No public profile email — the exchange must resolve the verified
          // primary from /user/emails, matching the web sign-in flow.
          email: null,
          name: "The Octocat",
          avatar_url: "https://avatars.example/octocat",
        });
      }
      if (url === "https://api.github.com/user/emails") {
        if (providerMock.githubEmailsStatus !== 200) {
          return Response.json({ message: "nope" }, { status: providerMock.githubEmailsStatus });
        }
        return Response.json(providerMock.githubEmailsBody);
      }
      if (url === "https://openidconnect.googleapis.com/v1/userinfo") {
        if (providerMock.googleStatus !== 200) {
          return Response.json({ error: "invalid_token" }, { status: providerMock.googleStatus });
        }
        return Response.json({
          sub: "1078462347",
          email: "person@example.com",
          email_verified: true,
          name: "A Person",
        });
      }
      return originalFetch(input, init);
    })
  );
}

async function serviceFetch(p: {
  service?: ServiceName;
  path: string;
  body: unknown;
}): Promise<Response> {
  const service = p.service ?? "web";
  const url = `https://test.local${p.path}`;
  const body = JSON.stringify(p.body);
  const headers = await buildServiceAuthHeaders({
    service,
    secret: `test-service-secret-${service}`,
    method: "POST",
    url,
    body,
  });
  return SELF.fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
}

interface TokenPair {
  accessToken: string;
  accessTokenExpiresAtEpochMs: number;
  refreshToken: string;
  refreshTokenExpiresAtEpochMs: number;
}

async function exchangeGitHub(): Promise<TokenPair> {
  const response = await serviceFetch({
    path: "/auth/tokens/exchange",
    body: {
      subjectTokenType: "github-access-token",
      subjectToken: "gho_valid",
      scmRefreshToken: "ghr_refresh",
      scmTokenExpiresAt: Date.now() + 60_000,
    },
  });
  expect(response.status).toBe(200);
  return response.json<TokenPair>();
}

async function expectNoDurableAuthState(): Promise<void> {
  for (const table of ["users", "user_identities", "user_scm_tokens", "api_tokens"]) {
    const count = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
      n: number;
    }>();
    expect(count?.n, table).toBe(0);
  }
}

describe("token exchange and refresh grant", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    providerMock.githubUserStatus = 200;
    providerMock.githubEmailsStatus = 200;
    providerMock.githubEmailsBody = [
      { email: "octocat@example.com", primary: true, verified: true },
    ];
    providerMock.googleStatus = 200;
    installProviderFetchMock();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("exchanges a GitHub subject: verified identity, canonical user, SCM capture, token pair", async () => {
    const pair = await exchangeGitHub();
    expect(pair.accessToken).toMatch(/^oi_at_/);
    expect(pair.refreshToken).toMatch(/^oi_rt_/);
    expect(pair.accessTokenExpiresAtEpochMs).toBeGreaterThan(Date.now());

    // Canonical user created from the VERIFIED identity (id 583231), not any asserted field.
    const identity = await new UserStore(env.DB).getIdentity("github", "583231");
    expect(identity).not.toBeNull();
    expect(identity!.providerLogin).toBe("octocat");

    // SCM tokens captured under the verified provider id.
    const scmRow = await env.DB.prepare(
      "SELECT user_id FROM user_scm_tokens WHERE provider_user_id = ?"
    )
      .bind("583231")
      .first<{ user_id: string }>();
    expect(scmRow?.user_id).toBe(identity!.userId);
  });

  it("authenticates CP requests with the minted access token (user principal end-to-end)", async () => {
    const pair = await exchangeGitHub();
    const response = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${pair.accessToken}` },
    });
    expect(response.status).toBe(200);
  });

  it("never re-links a user principal from providerEmail supplied to the identity route", async () => {
    const victim = await new UserStore(env.DB).createUser({
      displayName: "Victim",
      email: "victim@example.com",
      avatarUrl: null,
    });
    const pair = await exchangeGitHub();
    const before = await new UserStore(env.DB).getIdentity("github", "583231");
    expect(before).not.toBeNull();
    expect(before!.userId).not.toBe(victim.id);

    const response = await SELF.fetch("https://test.local/provider-identities/github/583231", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pair.accessToken}`,
      },
      body: JSON.stringify({ providerEmail: "victim@example.com" }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: before!.userId });
    const after = await new UserStore(env.DB).getIdentity("github", "583231");
    expect(after?.userId).toBe(before!.userId);
  });

  it("forbids a user token from resolving a different provider identity", async () => {
    const pair = await exchangeGitHub();

    const response = await SELF.fetch("https://test.local/provider-identities/github/999999", {
      method: "PUT",
      headers: { Authorization: `Bearer ${pair.accessToken}` },
    });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "Path identity does not match the authenticated user",
    });
  });

  it("persists session ownership from the user token rather than the request body", async () => {
    const pair = await exchangeGitHub();
    const identity = await new UserStore(env.DB).getIdentity("github", "583231");
    expect(identity).not.toBeNull();

    const created = await SELF.fetch("https://test.local/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pair.accessToken}`,
      },
      body: JSON.stringify({
        title: "Token-owned session",
        model: "anthropic/claude-haiku-4-5",
      }),
    });
    expect(created.status).toBe(201);

    const listed = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${pair.accessToken}` },
    });
    expect(listed.status).toBe(200);
    const body = await listed.json<{ sessions: Array<{ title: string; userId: string }> }>();
    expect(body.sessions).toContainEqual(
      expect.objectContaining({
        title: "Token-owned session",
        userId: identity!.userId,
      })
    );
  });

  it("rejects caller-supplied session identity before creating durable state", async () => {
    const pair = await exchangeGitHub();

    const created = await SELF.fetch("https://test.local/sessions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pair.accessToken}`,
      },
      body: JSON.stringify({
        title: "Forged owner",
        model: "anthropic/claude-haiku-4-5",
        userId: "victim-user-id",
      }),
    });

    expect(created.status).toBe(400);
    expect(await created.json()).toEqual({
      error: "Field 'userId' is not accepted from verified callers",
    });
    const sessionCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions").first<{
      n: number;
    }>();
    expect(sessionCount?.n).toBe(0);
  });

  it("exchanges a Google subject without SCM capture", async () => {
    const response = await serviceFetch({
      path: "/auth/tokens/exchange",
      body: { subjectTokenType: "google-access-token", subjectToken: "ya29.valid" },
    });
    expect(response.status).toBe(200);
    const identity = await new UserStore(env.DB).getIdentity("google", "1078462347");
    expect(identity).not.toBeNull();
    const scmCount = await env.DB.prepare("SELECT COUNT(*) AS n FROM user_scm_tokens").first<{
      n: number;
    }>();
    expect(scmCount?.n).toBe(0);
  });

  it("returns the same canonical user across repeated exchanges", async () => {
    await exchangeGitHub();
    await exchangeGitHub();
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(users?.n).toBe(1);
  });

  it("links a GitHub exchange with no public email to the email owner and mints the family there", async () => {
    // A canonical user already owns the email (e.g. a prior Google sign-in).
    const existing = await new UserStore(env.DB).createUser({
      displayName: "Octo",
      email: "octocat@example.com",
      avatarUrl: null,
    });

    // GitHub /user.email is null; the verified primary resolved from
    // /user/emails must link this exchange to `existing` instead of forking a
    // second canonical user and stranding the 90-day family on the orphan.
    await exchangeGitHub();

    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(users?.n).toBe(1);

    const identity = await new UserStore(env.DB).getIdentity("github", "583231");
    expect(identity?.userId).toBe(existing.id);

    // The minted token family is attached to the existing user, not an orphan.
    const familyRow = await env.DB.prepare(
      "SELECT DISTINCT user_id FROM api_tokens WHERE kind = 'web_session'"
    ).all<{ user_id: string }>();
    expect(familyRow.results.map((r) => r.user_id)).toEqual([existing.id]);
  });

  it("fails closed without durable identity state when GitHub email evidence is transiently unavailable", async () => {
    providerMock.githubEmailsStatus = 500;

    const response = await serviceFetch({
      path: "/auth/tokens/exchange",
      body: {
        subjectTokenType: "github-access-token",
        subjectToken: "gho_valid",
        scmRefreshToken: "ghr_refresh",
      },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider_unavailable" });
    await expectNoDurableAuthState();
  });

  it("fails closed without durable identity state on malformed GitHub email evidence", async () => {
    providerMock.githubEmailsBody = { email: "octocat@example.com" };

    const response = await serviceFetch({
      path: "/auth/tokens/exchange",
      body: {
        subjectTokenType: "github-access-token",
        subjectToken: "gho_valid",
        scmRefreshToken: "ghr_refresh",
      },
    });

    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({ error: "provider_unavailable" });
    await expectNoDurableAuthState();
  });

  it("rotates via the refresh grant; immediate replay is rejected without revoking the family", async () => {
    const first = await exchangeGitHub();

    const refreshResponse = await serviceFetch({
      path: "/auth/tokens/refresh",
      body: { refreshToken: first.refreshToken },
    });
    expect(refreshResponse.status).toBe(200);
    const second = await refreshResponse.json<TokenPair>();
    expect(second.accessToken).not.toBe(first.accessToken);

    // The rotated pair works.
    const ok = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${second.accessToken}` },
    });
    expect(ok.status).toBe(200);

    // Immediate replay of the consumed token = benign concurrent renewal:
    // superseded (NOT a dead grant), family left alive (grace window).
    // Post-grace replay revokes the family — covered by the service unit
    // tests.
    const replay = await serviceFetch({
      path: "/auth/tokens/refresh",
      body: { refreshToken: first.refreshToken },
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: "refresh_superseded" });

    const stillValid = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${second.accessToken}` },
    });
    expect(stillValid.status).toBe(200);
  });

  it("returns one winner when two refresh requests overlap", async () => {
    const first = await exchangeGitHub();
    const requests = await Promise.all([
      serviceFetch({
        path: "/auth/tokens/refresh",
        body: { refreshToken: first.refreshToken },
      }),
      serviceFetch({
        path: "/auth/tokens/refresh",
        body: { refreshToken: first.refreshToken },
      }),
    ]);

    expect(requests.map((response) => response.status).sort()).toEqual([200, 401]);
    const winnerResponse = requests.find((response) => response.status === 200)!;
    const loserResponse = requests.find((response) => response.status === 401)!;
    const winner = await winnerResponse.json<TokenPair>();
    expect(await loserResponse.json()).toEqual({ error: "refresh_superseded" });

    const winnerAccess = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${winner.accessToken}` },
    });
    expect(winnerAccess.status).toBe(200);

    const liveRefreshLeaves = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM api_tokens
       WHERE kind = 'web_session_refresh' AND rotated_to IS NULL AND revoked_at IS NULL`
    ).first<{ n: number }>();
    expect(liveRefreshLeaves?.n).toBe(1);
  });

  it("revokes the real D1 family when a consumed refresh token is replayed after grace", async () => {
    const first = await exchangeGitHub();
    const rotated = await serviceFetch({
      path: "/auth/tokens/refresh",
      body: { refreshToken: first.refreshToken },
    });
    expect(rotated.status).toBe(200);
    const second = await rotated.json<TokenPair>();

    const ancestor = await env.DB.prepare(
      "SELECT family_id, rotated_to FROM api_tokens WHERE kind = 'web_session_refresh' AND rotated_to IS NOT NULL"
    ).first<{ family_id: string; rotated_to: string }>();
    expect(ancestor).not.toBeNull();
    await env.DB.prepare("UPDATE api_tokens SET created_at = ? WHERE id = ?")
      .bind(Date.now() - REFRESH_REUSE_GRACE_MS - 1000, ancestor!.rotated_to)
      .run();

    const replay = await serviceFetch({
      path: "/auth/tokens/refresh",
      body: { refreshToken: first.refreshToken },
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toEqual({ error: "refresh_reuse_detected" });

    const winnerAccess = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${second.accessToken}` },
    });
    expect(winnerAccess.status).toBe(401);

    const familyRows = await env.DB.prepare("SELECT revoked_at FROM api_tokens WHERE family_id = ?")
      .bind(ancestor!.family_id)
      .all<{ revoked_at: number | null }>();
    expect(familyRows.results.length).toBeGreaterThan(0);
    expect(familyRows.results.every((row) => row.revoked_at !== null)).toBe(true);
  });

  it("rejects invalid refresh tokens", async () => {
    const response = await serviceFetch({
      path: "/auth/tokens/refresh",
      body: { refreshToken: "oi_rt_never_issued" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_refresh_token" });
  });

  it("forbids refresh to every principal except the web service", async () => {
    const pair = await exchangeGitHub();
    const body = { refreshToken: pair.refreshToken };

    for (const service of ["slack-bot", "github-bot", "linear-bot", "modal"] as const) {
      const response = await serviceFetch({
        service,
        path: "/auth/tokens/refresh",
        body,
      });
      expect(response.status, service).toBe(403);
    }

    const asUser = await SELF.fetch("https://test.local/auth/tokens/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pair.accessToken}`,
      },
      body: JSON.stringify(body),
    });
    expect(asUser.status).toBe(403);

    const unauthenticated = await SELF.fetch("https://test.local/auth/tokens/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(unauthenticated.status).toBe(401);

    const sharedToken = await generateInternalToken("test-hmac-secret-for-integration-tests");
    const asSharedBearer = await SELF.fetch("https://test.local/auth/tokens/refresh", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sharedToken}`,
      },
      body: JSON.stringify(body),
    });
    expect(asSharedBearer.status).toBe(401);

    const asWeb = await serviceFetch({
      path: "/auth/tokens/refresh",
      body,
    });
    expect(asWeb.status).toBe(200);
  });

  it("maps provider rejection to subject_rejected and provider outage to provider_unavailable", async () => {
    providerMock.githubUserStatus = 401;
    const rejected = await serviceFetch({
      path: "/auth/tokens/exchange",
      body: { subjectTokenType: "github-access-token", subjectToken: "gho_bad" },
    });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ error: "subject_rejected" });

    providerMock.githubUserStatus = 500;
    const unavailable = await serviceFetch({
      path: "/auth/tokens/exchange",
      body: { subjectTokenType: "github-access-token", subjectToken: "gho_any" },
    });
    expect(unavailable.status).toBe(502);
    expect(await unavailable.json()).toMatchObject({ error: "provider_unavailable" });

    // Fail closed: no user, no tokens.
    const users = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(users?.n).toBe(0);
  });

  it("rejects malformed exchange bodies", async () => {
    const response = await serviceFetch({
      path: "/auth/tokens/exchange",
      body: { subjectTokenType: "github-access-token", subjectToken: "", extra: true },
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  it("forbids exchange to any principal but web's service credential", async () => {
    const bodies = {
      subjectTokenType: "github-access-token",
      subjectToken: "gho_valid",
    };

    const asSlackBot = await serviceFetch({
      service: "slack-bot",
      path: "/auth/tokens/exchange",
      body: bodies,
    });
    expect(asSlackBot.status).toBe(403);

    // The retired shared bearer no longer authenticates at all — rejected at
    // the edge (401), before the route's 403 gate is even reached.
    const sharedToken = await generateInternalToken("test-hmac-secret-for-integration-tests");
    const asSharedBearer = await SELF.fetch("https://test.local/auth/tokens/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${sharedToken}`,
      },
      body: JSON.stringify(bodies),
    });
    expect(asSharedBearer.status).toBe(401);

    // A minted user token cannot mint further tokens either.
    const pair = await exchangeGitHub();
    const asUser = await SELF.fetch("https://test.local/auth/tokens/exchange", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${pair.accessToken}`,
      },
      body: JSON.stringify(bodies),
    });
    expect(asUser.status).toBe(403);
  });
});

describe("api_tokens retention sweep", () => {
  beforeEach(async () => {
    await cleanD1Tables();
  });

  function newToken(suffix: string, expiresAt: number): NewApiToken {
    return {
      tokenHash: `hash-${suffix}`,
      kind: "web_session",
      userId: "user-1",
      provider: "github",
      providerUserId: "583231",
      familyId: `family-${suffix}`,
      expiresAt,
      familyExpiresAt: null,
    };
  }

  it("deletes only rows past the retention window", async () => {
    const store = new ApiTokenStore(env.DB);
    const now = Date.now();
    // One pair long past expiry, one expired but within retention, one live.
    await store.createPair([
      newToken("stale-a", now - EXPIRED_TOKEN_RETENTION_MS - 60_000),
      newToken("stale-b", now - EXPIRED_TOKEN_RETENTION_MS - 60_000),
    ]);
    await store.createPair([newToken("recent-a", now - 60_000), newToken("live-a", now + 60_000)]);

    expect(await store.deleteExpired(now)).toBe(2);

    const remaining = await env.DB.prepare("SELECT token_hash FROM api_tokens").all<{
      token_hash: string;
    }>();
    expect(remaining.results.map((r) => r.token_hash).sort()).toEqual([
      "hash-live-a",
      "hash-recent-a",
    ]);
  });

  it("retains family-scoped refresh rows until the family expires", async () => {
    const store = new ApiTokenStore(env.DB);
    const now = Date.now();
    const longPast = now - EXPIRED_TOKEN_RETENTION_MS - 60_000;
    // Both rows are long past their own expiry; only the dead family's row
    // may go — a consumed ancestor in a live family must survive so its
    // replay still reads as reuse instead of an unknown token.
    await store.createPair([
      {
        ...newToken("live-family", longPast),
        kind: "web_session_refresh",
        familyExpiresAt: now + 60_000,
      },
      {
        ...newToken("dead-family", longPast),
        kind: "web_session_refresh",
        familyExpiresAt: longPast,
      },
    ]);

    expect(await store.deleteExpired(now)).toBe(1);

    const remaining = await env.DB.prepare("SELECT token_hash FROM api_tokens").all<{
      token_hash: string;
    }>();
    expect(remaining.results.map((r) => r.token_hash)).toEqual(["hash-live-family"]);
  });

  it("admits exactly one successor when refresh consumers race in D1", async () => {
    const store = new ApiTokenStore(env.DB);
    const now = Date.now();
    const [, refreshId] = await store.createPair([
      newToken("race-access", now + 60_000),
      {
        ...newToken("race-refresh", now + 60_000),
        kind: "web_session_refresh",
        familyId: "family-race",
        familyExpiresAt: now + 120_000,
      },
    ]);

    const outcomes = await Promise.all([
      store.consumeRefreshToken(refreshId, "successor-a"),
      store.consumeRefreshToken(refreshId, "successor-b"),
    ]);

    expect(outcomes.filter(Boolean)).toHaveLength(1);
    expect((await store.getById(refreshId))?.rotatedTo).toBe(
      outcomes[0] ? "successor-a" : "successor-b"
    );
  });
});
