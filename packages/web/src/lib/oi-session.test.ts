import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JWT } from "next-auth/jwt";
import type { Account } from "next-auth";

vi.mock("@/lib/control-plane-transport", () => ({
  controlPlaneServiceFetch: vi.fn(),
}));

import { controlPlaneServiceFetch } from "@/lib/control-plane-transport";
import { encode } from "next-auth/jwt";
import {
  applyOiSessionTokens,
  getLiveOiAccessToken,
  readOiAccessTokenFromCookiePairs,
  renewOiSessionTokens,
  OI_ACCESS_TOKEN_RENEW_WINDOW_MS,
} from "@/lib/oi-session";

const serviceFetch = vi.mocked(controlPlaneServiceFetch);

const PAIR = {
  accessToken: "oi_at_fresh",
  accessTokenExpiresAtEpochMs: Date.now() + 8 * 60 * 60 * 1000,
  refreshToken: "oi_rt_fresh",
  refreshTokenExpiresAtEpochMs: Date.now() + 30 * 24 * 60 * 60 * 1000,
};

function githubAccount(overrides: Partial<Account> = {}): Account {
  return {
    provider: "github",
    providerAccountId: "583231",
    type: "oauth",
    access_token: "gho_subject",
    refresh_token: "ghr_refresh",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    ...overrides,
  } as Account;
}

function pairResponse(): Response {
  return new Response(JSON.stringify(PAIR), { status: 200 });
}

function errorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), { status });
}

beforeEach(() => {
  serviceFetch.mockReset();
});

describe("applyOiSessionTokens — sign-in exchange", () => {
  it("exchanges a GitHub subject with SCM capture fields", async () => {
    serviceFetch.mockResolvedValue(pairResponse());
    const token = await applyOiSessionTokens({} as JWT, githubAccount());

    expect(serviceFetch).toHaveBeenCalledWith("/auth/tokens/exchange", {
      method: "POST",
      body: expect.any(String),
    });
    const body = JSON.parse(serviceFetch.mock.calls[0][1].body!) as Record<string, unknown>;
    expect(body).toMatchObject({
      subjectTokenType: "github-access-token",
      subjectToken: "gho_subject",
      scmRefreshToken: "ghr_refresh",
    });
    expect(typeof body.scmTokenExpiresAt).toBe("number");

    expect(token.oiAccessToken).toBe("oi_at_fresh");
    expect(token.oiRefreshToken).toBe("oi_rt_fresh");
    expect(token.oiAccessTokenExpiresAt).toBe(PAIR.accessTokenExpiresAtEpochMs);
  });

  it("exchanges a Google subject without SCM fields", async () => {
    serviceFetch.mockResolvedValue(pairResponse());
    await applyOiSessionTokens(
      {} as JWT,
      githubAccount({ provider: "google", refresh_token: "google-refresh" })
    );
    const body = JSON.parse(serviceFetch.mock.calls[0][1].body!) as Record<string, unknown>;
    expect(body.subjectTokenType).toBe("google-access-token");
    expect(body.scmRefreshToken).toBeUndefined();
  });

  it("falls back with unset fields when the exchange fails", async () => {
    serviceFetch.mockResolvedValue(errorResponse(401, "subject_rejected"));
    const token = await applyOiSessionTokens(
      { oiAccessToken: "oi_at_stale" } as JWT,
      githubAccount()
    );
    expect(token.oiAccessToken).toBeUndefined();
    expect(token.oiRefreshToken).toBeUndefined();
  });

  it("falls back when the service credential is unavailable", async () => {
    serviceFetch.mockRejectedValue(new Error("SERVICE_AUTH_SECRET not configured"));
    const token = await applyOiSessionTokens({} as JWT, githubAccount());
    expect(token.oiAccessToken).toBeUndefined();
  });

  it("clears stale fields for unrecognized providers", async () => {
    const token = await applyOiSessionTokens(
      { oiAccessToken: "oi_at_stale" } as JWT,
      githubAccount({ provider: "gitlab" })
    );
    expect(serviceFetch).not.toHaveBeenCalled();
    expect(token.oiAccessToken).toBeUndefined();
  });
});

describe("applyOiSessionTokens — jwt callback never renews", () => {
  it("leaves a near-expiry token untouched without an account (renewal is the refresh route's job)", async () => {
    const token = {
      oiAccessToken: "oi_at_old",
      oiAccessTokenExpiresAt: Date.now() + OI_ACCESS_TOKEN_RENEW_WINDOW_MS - 60_000,
      oiRefreshToken: "oi_rt_old",
    } as JWT;
    const result = await applyOiSessionTokens(token, null);
    expect(serviceFetch).not.toHaveBeenCalled();
    expect(result.oiAccessToken).toBe("oi_at_old");
    expect(result.oiRefreshToken).toBe("oi_rt_old");
  });
});

describe("renewOiSessionTokens", () => {
  function nearExpiryToken(): JWT {
    return {
      oiAccessToken: "oi_at_old",
      oiAccessTokenExpiresAt: Date.now() + OI_ACCESS_TOKEN_RENEW_WINDOW_MS - 60_000,
      oiRefreshToken: "oi_rt_old",
    } as JWT;
  }

  it("redeems the refresh grant when the access token nears expiry", async () => {
    serviceFetch.mockResolvedValue(pairResponse());
    const token = nearExpiryToken();
    const result = await renewOiSessionTokens(token);

    expect(serviceFetch).toHaveBeenCalledWith("/auth/tokens/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken: "oi_rt_old" }),
    });
    expect(result.changed).toBe(true);
    expect(token.oiAccessToken).toBe("oi_at_fresh");
    expect(token.oiRefreshToken).toBe("oi_rt_fresh");
  });

  it("leaves fresh tokens alone", async () => {
    const token = {
      oiAccessToken: "oi_at_live",
      oiAccessTokenExpiresAt: Date.now() + OI_ACCESS_TOKEN_RENEW_WINDOW_MS + 60_000,
      oiRefreshToken: "oi_rt_live",
    } as JWT;
    const result = await renewOiSessionTokens(token);
    expect(serviceFetch).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
    expect(token.oiAccessToken).toBe("oi_at_live");
  });

  it("does nothing when the token carries no oi fields", async () => {
    const result = await renewOiSessionTokens({} as JWT);
    expect(serviceFetch).not.toHaveBeenCalled();
    expect(result.changed).toBe(false);
  });

  it("keeps a still-valid access token when a concurrent renewal won the race", async () => {
    serviceFetch.mockResolvedValue(errorResponse(401, "invalid_refresh_token"));
    const token = nearExpiryToken();
    const result = await renewOiSessionTokens(token);
    expect(result.changed).toBe(false);
    expect(token.oiAccessToken).toBe("oi_at_old");
    expect(token.oiRefreshToken).toBe("oi_rt_old");
  });

  it("clears the fields on refresh reuse detection and reports the change for persistence", async () => {
    serviceFetch.mockResolvedValue(errorResponse(401, "refresh_reuse_detected"));
    const token = nearExpiryToken();
    const result = await renewOiSessionTokens(token);
    expect(result.changed).toBe(true);
    expect(token.oiAccessToken).toBeUndefined();
    expect(token.oiRefreshToken).toBeUndefined();
  });

  it("clears the fields when the token is invalid and the access token has expired", async () => {
    serviceFetch.mockResolvedValue(errorResponse(401, "invalid_refresh_token"));
    const token = {
      oiAccessToken: "oi_at_dead",
      oiAccessTokenExpiresAt: Date.now() - 1000,
      oiRefreshToken: "oi_rt_dead",
    } as JWT;
    const result = await renewOiSessionTokens(token);
    expect(result.changed).toBe(true);
    expect(token.oiAccessToken).toBeUndefined();
  });

  it("keeps the fields on transient request failures", async () => {
    serviceFetch.mockRejectedValue(new Error("network down"));
    const token = nearExpiryToken();
    const result = await renewOiSessionTokens(token);
    expect(result.changed).toBe(false);
    expect(token.oiAccessToken).toBe("oi_at_old");
    expect(token.oiRefreshToken).toBe("oi_rt_old");
  });
});

describe("getLiveOiAccessToken", () => {
  it("returns the token only while comfortably unexpired", () => {
    expect(
      getLiveOiAccessToken({
        oiAccessToken: "oi_at_x",
        oiAccessTokenExpiresAt: Date.now() + 10 * 60 * 1000,
      } as JWT)
    ).toBe("oi_at_x");
    expect(
      getLiveOiAccessToken({
        oiAccessToken: "oi_at_x",
        oiAccessTokenExpiresAt: Date.now() + 30_000,
      } as JWT)
    ).toBeNull();
    expect(getLiveOiAccessToken({} as JWT)).toBeNull();
    expect(getLiveOiAccessToken(null)).toBeNull();
  });
});

describe("readOiAccessTokenFromCookiePairs", () => {
  const SECURE_COOKIE = "__Secure-next-auth.session-token";
  const SECRET = "test-nextauth-secret-for-round-trip";

  beforeEach(() => {
    vi.stubEnv("NEXTAUTH_SECRET", SECRET);
    // https URL → getToken looks for the __Secure- cookie name, as in prod.
    vi.stubEnv("NEXTAUTH_URL", "https://open-inspect.example");
  });

  async function encodedJwtWithPair(): Promise<string> {
    // Real next-auth encode — no mocking. This pins the exact seam that
    // regressed: getToken reads req.cookies, never a headers.cookie string.
    return encode({
      token: {
        oiAccessToken: "oi_at_round_trip",
        oiAccessTokenExpiresAt: Date.now() + 8 * 60 * 60 * 1000,
        oiRefreshToken: "oi_rt_round_trip",
      },
      secret: SECRET,
    });
  }

  it("round-trips a live token through a real encoded session cookie", async () => {
    const jwt = await encodedJwtWithPair();
    await expect(readOiAccessTokenFromCookiePairs({ [SECURE_COOKIE]: jwt })).resolves.toBe(
      "oi_at_round_trip"
    );
  });

  it("reassembles chunked session cookies", async () => {
    const jwt = await encodedJwtWithPair();
    const half = Math.ceil(jwt.length / 2);
    await expect(
      readOiAccessTokenFromCookiePairs({
        [`${SECURE_COOKIE}.0`]: jwt.slice(0, half),
        [`${SECURE_COOKIE}.1`]: jwt.slice(half),
      })
    ).resolves.toBe("oi_at_round_trip");
  });

  it("returns null for unrelated cookies and undecodable tokens", async () => {
    await expect(readOiAccessTokenFromCookiePairs({ other: "value" })).resolves.toBeNull();
    await expect(
      readOiAccessTokenFromCookiePairs({ [SECURE_COOKIE]: "not-a-jwe" })
    ).resolves.toBeNull();
  });
});
