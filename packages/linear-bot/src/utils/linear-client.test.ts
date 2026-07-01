import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeCodeForToken,
  fetchUser,
  getLinearAuthContext,
  getOAuthTokenOrThrow,
  getOAuthTokenResult,
  postAuthFailureCommentFallback,
} from "./linear-client";
import type { LinearApiClient } from "./linear-client";
import { createFakeKV, makeLinearBotEnv } from "../test-helpers";
import { getLinearAuthState } from "../kv-store";

const client: LinearApiClient = { accessToken: "test-token" };
const FRESH_TOKEN_EXPIRES_IN_MS = 10 * 60 * 1000;
const NEAR_EXPIRY_TOKEN_EXPIRES_IN_MS = 4 * 60 * 1000;
const EXPIRED_TOKEN_AGE_MS = 60 * 1000;

function mockFetchResponse(data: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    })
  );
}

describe("fetchUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns user with name and email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-1", name: "Alice", email: "alice@example.com" },
      },
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toEqual({
      id: "user-1",
      name: "Alice",
      email: "alice@example.com",
    });
  });

  it("returns null email when user has no email", async () => {
    mockFetchResponse({
      data: {
        user: { id: "user-2", name: "Bob", email: null },
      },
    });

    const result = await fetchUser(client, "user-2");
    expect(result).toEqual({
      id: "user-2",
      name: "Bob",
      email: null,
    });
  });

  it("returns null when user is not found", async () => {
    mockFetchResponse({ data: { user: null } });

    const result = await fetchUser(client, "nonexistent");
    expect(result).toBeNull();
  });

  it("returns null on API error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })
    );

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });

  it("returns null on GraphQL errors payload", async () => {
    mockFetchResponse({
      data: null,
      errors: [{ message: "Not authorized" }],
    });

    const result = await fetchUser(client, "user-1");
    expect(result).toBeNull();
  });
});

describe("getOAuthTokenOrThrow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function envWithToken(raw?: string) {
    const { kv, store } = createFakeKV(raw === undefined ? {} : { "oauth:token:org-1": raw });
    return { env: makeLinearBotEnv(kv), store };
  }

  function expectAuthFailure(promise: Promise<unknown>, failure: Record<string, unknown>) {
    return expect(promise).rejects.toMatchObject({
      name: "LinearAuthError",
      ...failure,
    });
  }

  it("throws an auth error when the workspace token is missing", async () => {
    const { env } = envWithToken();

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "missing_token",
    });
  });

  it("throws an auth error when the workspace token is malformed", async () => {
    const { env } = envWithToken("{not-json");

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "malformed_token",
    });
  });

  it("throws an auth error when the workspace token shape is invalid", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        refresh_token: "refresh-token",
        expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
      })
    );

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "malformed_token",
    });
  });

  it("throws an auth error when the token read fails", async () => {
    const { env } = envWithToken();
    const kvGet = env.LINEAR_KV.get as unknown as ReturnType<typeof vi.fn>;
    kvGet.mockRejectedValueOnce(new Error("kv down"));

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "token_read_error",
    });
  });

  it.each([
    {
      name: "non-object JSON",
      raw: "null",
    },
    {
      name: "missing access token",
      raw: JSON.stringify({
        refresh_token: "refresh-token",
        expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
      }),
    },
    {
      name: "non-string access token",
      raw: JSON.stringify({
        access_token: 123,
        refresh_token: "refresh-token",
        expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
      }),
    },
    {
      name: "non-number expiry",
      raw: JSON.stringify({
        access_token: "fresh-token",
        refresh_token: "refresh-token",
        expires_at: String(Date.now() + FRESH_TOKEN_EXPIRES_IN_MS),
      }),
    },
    {
      name: "non-string refresh token",
      raw: JSON.stringify({
        access_token: "fresh-token",
        refresh_token: 123,
        expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
      }),
    },
  ])("requires reauthorization when the stored token has $name", async ({ raw }) => {
    const { env } = envWithToken(raw);

    await expect(getOAuthTokenResult(env, "org-1")).resolves.toMatchObject({
      ok: false,
      reason: "malformed_token",
      reauthorizationRequired: true,
      retryable: false,
    });
  });

  it("returns a fresh token without refreshing", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "fresh-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
      })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOAuthTokenOrThrow(env, "org-1")).resolves.toBe("fresh-token");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes a token that expires within the refresh skew", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "nearly-expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + NEAR_EXPIRY_TOKEN_EXPIRES_IN_MS,
      })
    );
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: "new-access-token",
          refresh_token: "new-refresh-token",
          expires_in: 3600,
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOAuthTokenResult(env, "org-1")).resolves.toEqual({
      ok: true,
      token: "new-access-token",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("returns a fresh access token without requiring a refresh token", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "fresh-token",
        expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
      })
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOAuthTokenResult(env, "org-1")).resolves.toEqual({
      ok: true,
      token: "fresh-token",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws an auth error when an expired token has no refresh token", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "missing_refresh_token",
    });
  });

  it("classifies invalid_grant refresh failures", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "Refresh token has expired.",
            })
          ),
      })
    );

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "refresh_invalid_grant",
      status: 400,
      oauthError: "invalid_grant",
      oauthErrorDescription: "Refresh token has expired.",
    });
  });

  it("classifies other refresh HTTP failures", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("temporarily unavailable"),
      })
    );

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "refresh_failed",
      status: 503,
    });
  });

  it("classifies refresh exceptions", async () => {
    const { env } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expectAuthFailure(getOAuthTokenOrThrow(env, "org-1"), {
      reason: "refresh_error",
    });
  });

  it("stores and returns refreshed tokens", async () => {
    const { env, store } = envWithToken(
      JSON.stringify({
        access_token: "expired-token",
        refresh_token: "old-refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      })
    );
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "new-access-token",
            refresh_token: "new-refresh-token",
            expires_in: 3600,
          }),
      })
    );

    await expect(getOAuthTokenOrThrow(env, "org-1")).resolves.toBe("new-access-token");
    expect(JSON.parse(store.get("oauth:token:org-1") ?? "{}")).toMatchObject({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
    });
  });
});

describe("getLinearAuthContext", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records reauthorization-required auth health for invalid_grant refresh failures", async () => {
    const { kv } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      }),
    });
    const env = makeLinearBotEnv(kv);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () =>
          Promise.resolve(
            JSON.stringify({
              error: "invalid_grant",
              error_description: "Refresh token has expired.",
            })
          ),
      })
    );

    await expect(getLinearAuthContext(env, "org-1", "trace-1")).resolves.toMatchObject({
      ok: false,
      reason: "refresh_invalid_grant",
      authStatus: "reauthorization_required",
      reconnectUrl: "https://linear-bot.example.test/oauth/authorize",
    });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "reauthorization_required",
      reason: "refresh_invalid_grant",
      lastTraceId: "trace-1",
      details: {
        oauthStatus: 400,
        oauthError: "invalid_grant",
        oauthErrorDescription: "Refresh token has expired.",
      },
    });
  });

  it("records transient auth health for retryable refresh failures", async () => {
    const { kv } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      }),
    });
    const env = makeLinearBotEnv(kv);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        text: () => Promise.resolve("temporarily unavailable"),
      })
    );

    await expect(getLinearAuthContext(env, "org-1", "trace-2")).resolves.toMatchObject({
      ok: false,
      reason: "refresh_failed",
      authStatus: "transient_failure",
    });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "transient_failure",
      reason: "refresh_failed",
      lastTraceId: "trace-2",
      details: { oauthStatus: 503 },
    });
  });

  it("records transient auth health when the token read fails", async () => {
    const { kv, store } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    const kvGet = env.LINEAR_KV.get as unknown as ReturnType<typeof vi.fn>;
    kvGet.mockImplementationOnce(async () => null);
    kvGet.mockRejectedValueOnce(new Error("kv down"));

    await expect(getLinearAuthContext(env, "org-1", "trace-kv")).resolves.toMatchObject({
      ok: false,
      reason: "token_read_error",
      authStatus: "transient_failure",
    });
    expect(JSON.parse(store.get("linear_auth:org-1") ?? "{}")).toMatchObject({
      status: "transient_failure",
      reason: "token_read_error",
      lastTraceId: "trace-kv",
    });
  });

  it.each([
    {
      name: "missing token",
      initial: undefined,
      expectedReason: "missing_token",
    },
    {
      name: "malformed token",
      initial: "{not-json",
      expectedReason: "malformed_token",
    },
    {
      name: "missing refresh token",
      initial: JSON.stringify({
        access_token: "expired-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      }),
      expectedReason: "missing_refresh_token",
    },
  ])(
    "records reauthorization-required auth health for $name",
    async ({ initial, expectedReason }) => {
      const { kv } = createFakeKV(initial === undefined ? {} : { "oauth:token:org-1": initial });
      const env = makeLinearBotEnv(kv);

      await expect(getLinearAuthContext(env, "org-1", "trace-reauth")).resolves.toMatchObject({
        ok: false,
        reason: expectedReason,
        authStatus: "reauthorization_required",
      });
      await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
        status: "reauthorization_required",
        reason: expectedReason,
        lastTraceId: "trace-reauth",
      });
    }
  );

  it("records transient auth health for refresh exceptions", async () => {
    const { kv } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "expired-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() - EXPIRED_TOKEN_AGE_MS,
      }),
    });
    const env = makeLinearBotEnv(kv);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    await expect(getLinearAuthContext(env, "org-1", "trace-error")).resolves.toMatchObject({
      ok: false,
      reason: "refresh_error",
      authStatus: "transient_failure",
    });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "transient_failure",
      reason: "refresh_error",
      lastTraceId: "trace-error",
    });
  });

  it.each(["oauth_app_revoked", "permission_team_access_removed"])(
    "keeps persisted webhook reason %s sticky until OAuth callback succeeds",
    async (reason) => {
      const { kv } = createFakeKV({
        "oauth:token:org-1": JSON.stringify({
          access_token: "fresh-token",
          refresh_token: "refresh-token",
          expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
        }),
        "linear_auth:org-1": JSON.stringify({
          schemaVersion: 1,
          orgId: "org-1",
          status: "reauthorization_required",
          reason,
          updatedAt: Date.now(),
        }),
      });
      const env = makeLinearBotEnv(kv);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(getLinearAuthContext(env, "org-1", "trace-sticky")).resolves.toMatchObject({
        ok: false,
        reason,
        authStatus: "reauthorization_required",
      });
      expect(fetchMock).not.toHaveBeenCalled();
      await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
        status: "reauthorization_required",
        reason,
      });
    }
  );

  it("marks a previously transient workspace connected when a fresh token is usable", async () => {
    const { kv } = createFakeKV({
      "oauth:token:org-1": JSON.stringify({
        access_token: "fresh-token",
        refresh_token: "refresh-token",
        expires_at: Date.now() + FRESH_TOKEN_EXPIRES_IN_MS,
      }),
      "linear_auth:org-1": JSON.stringify({
        schemaVersion: 1,
        orgId: "org-1",
        status: "transient_failure",
        reason: "refresh_error",
        updatedAt: Date.now(),
      }),
    });
    const env = makeLinearBotEnv(kv);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(getLinearAuthContext(env, "org-1", "trace-connected")).resolves.toMatchObject({
      ok: true,
      client: { accessToken: "fresh-token" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "connected",
      reason: "client_available",
      lastTraceId: "trace-connected",
    });
  });
});

describe("postAuthFailureCommentFallback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("records rejected fallback comments as failed notifications with HTTP status", async () => {
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { LINEAR_API_KEY: "linear-api-key" });
    await getLinearAuthContext(env, "org-1", "trace-1");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 403,
      })
    );

    await expect(
      postAuthFailureCommentFallback(env, {
        orgId: "org-1",
        issueId: "issue-1",
        issueIdentifier: "ORI-229",
        agentSessionId: "agent-session-1",
        traceId: "trace-1",
        status: "reauthorization_required",
        reason: "missing_token",
        body: "Reconnect Open-Inspect.",
      })
    ).resolves.toEqual({ outcome: "failed", success: false });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      lastNotification: {
        issueId: "issue-1",
        issueIdentifier: "ORI-229",
        agentSessionId: "agent-session-1",
        outcome: "failed",
        failureReason: "linear_api_rejected",
        httpStatus: 403,
      },
    });
  });

  it("records fallback comment exceptions as failed notifications", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { kv } = createFakeKV();
    const env = makeLinearBotEnv(kv, { LINEAR_API_KEY: "linear-api-key" });
    await getLinearAuthContext(env, "org-1", "trace-1");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network unavailable")));

    await expect(
      postAuthFailureCommentFallback(env, {
        orgId: "org-1",
        issueId: "issue-1",
        issueIdentifier: "ORI-229",
        agentSessionId: "agent-session-1",
        traceId: "trace-1",
        status: "reauthorization_required",
        reason: "missing_token",
        body: "Reconnect Open-Inspect.",
      })
    ).resolves.toEqual({ outcome: "failed", success: false });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      lastNotification: {
        issueId: "issue-1",
        issueIdentifier: "ORI-229",
        agentSessionId: "agent-session-1",
        outcome: "failed",
        failureReason: "post_exception",
      },
    });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("linear.auth_failure_comment_fallback_exception")
    );
    errorSpy.mockRestore();
  });
});

describe("exchangeCodeForToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stores connected auth health with app actor identity", async () => {
    const { kv, store } = createFakeKV();
    const env = makeLinearBotEnv(kv);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              access_token: "access-token",
              token_type: "Bearer",
              expires_in: 3600,
              refresh_token: "refresh-token",
            }),
        })
        .mockResolvedValueOnce({
          ok: true,
          json: () =>
            Promise.resolve({
              data: {
                viewer: {
                  id: "app-user-1",
                  name: "Open-Inspect",
                  organization: { id: "org-1", name: "Acme" },
                },
              },
            }),
        })
    );

    await expect(exchangeCodeForToken(env, "code-1", "trace-1")).resolves.toEqual({
      orgId: "org-1",
      orgName: "Acme",
    });
    expect(JSON.parse(store.get("oauth:token:org-1") ?? "{}")).toMatchObject({
      access_token: "access-token",
      refresh_token: "refresh-token",
    });
    await expect(getLinearAuthState(env, "org-1")).resolves.toMatchObject({
      status: "connected",
      reason: "oauth_callback",
      lastTraceId: "trace-1",
      installation: {
        orgName: "Acme",
        appUserId: "app-user-1",
        appUserName: "Open-Inspect",
      },
    });
  });
});
