import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SELF, env } from "cloudflare:test";
import { buildServiceAuthHeaders, generateInternalToken } from "@open-inspect/shared";
import {
  ApiTokenStore,
  EXPIRED_TOKEN_RETENTION_MS,
  type NewApiToken,
} from "../../src/db/api-tokens";
import { UserStore } from "../../src/db/user-store";
import { cleanD1Tables } from "./cleanup";

const originalFetch = globalThis.fetch;

interface ProviderMockState {
  githubStatus: number;
  googleStatus: number;
}

const providerMock: ProviderMockState = { githubStatus: 200, googleStatus: 200 };

function installProviderFetchMock(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

      if (url === "https://api.github.com/user") {
        if (providerMock.githubStatus !== 200) {
          return Response.json({ message: "nope" }, { status: providerMock.githubStatus });
        }
        return Response.json({
          id: 583231,
          login: "octocat",
          name: "The Octocat",
          email: "octocat@example.com",
          avatar_url: "https://avatars.example/octocat",
        });
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
  service?: "web" | "slack-bot";
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

describe("token exchange and refresh grant", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    providerMock.githubStatus = 200;
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
    // rejected without a pair, family left alive (grace window). Post-grace
    // replay revokes the family — covered by the service unit tests.
    const replay = await serviceFetch({
      path: "/auth/tokens/refresh",
      body: { refreshToken: first.refreshToken },
    });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: "invalid_refresh_token" });

    const stillValid = await SELF.fetch("https://test.local/sessions", {
      headers: { Authorization: `Bearer ${second.accessToken}` },
    });
    expect(stillValid.status).toBe(200);
  });

  it("rejects invalid refresh tokens", async () => {
    const response = await serviceFetch({
      path: "/auth/tokens/refresh",
      body: { refreshToken: "oi_rt_never_issued" },
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({ error: "invalid_refresh_token" });
  });

  it("maps provider rejection to subject_rejected and provider outage to provider_unavailable", async () => {
    providerMock.githubStatus = 401;
    const rejected = await serviceFetch({
      path: "/auth/tokens/exchange",
      body: { subjectTokenType: "github-access-token", subjectToken: "gho_bad" },
    });
    expect(rejected.status).toBe(401);
    expect(await rejected.json()).toMatchObject({ error: "subject_rejected" });

    providerMock.githubStatus = 500;
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
});
