import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exchangeCodeForToken, fetchUser, getOAuthToken } from "./linear-client";
import type { LinearApiClient } from "./linear-client";
import type { Env } from "../types";

const client: LinearApiClient = { accessToken: "test-token" };

function mockFetchResponse(data: unknown): void {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(data),
    })
  );
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    LINEAR_KV: {
      get: vi.fn(),
      put: vi.fn(),
    },
    LINEAR_CLIENT_ID: "client-id",
    LINEAR_CLIENT_SECRET: "client-secret",
    WORKER_URL: "https://worker.example.com",
    CONTROL_PLANE: { fetch: vi.fn() },
    DEPLOYMENT_NAME: "test",
    CONTROL_PLANE_URL: "https://control.example.com",
    WEB_APP_URL: "https://web.example.com",
    DEFAULT_MODEL: "claude-sonnet-4-5-20250929",
    LINEAR_WEBHOOK_SECRET: "secret",
    ANTHROPIC_API_KEY: "anthropic-key",
    ...overrides,
  } as unknown as Env;
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

describe("exchangeCodeForToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a valid OAuth token response and stores token data", async () => {
    const env = createEnv();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 3600,
            refresh_token: "refresh-token",
            scope: "read,write",
          }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            data: { viewer: { organization: { id: "org-1", name: "Test Org" } } },
          }),
      });
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeCodeForToken(env, "oauth-code")).resolves.toEqual({
      orgId: "org-1",
      orgName: "Test Org",
    });
    expect(env.LINEAR_KV.put).toHaveBeenCalledWith(
      "oauth:token:org-1",
      expect.stringContaining("access-token")
    );
  });

  it("rejects a partial OAuth token response", async () => {
    const env = createEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: "access-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
      })
    );

    await expect(exchangeCodeForToken(env, "oauth-code")).rejects.toThrow(
      "Invalid Linear OAuth token response"
    );
    expect(env.LINEAR_KV.put).not.toHaveBeenCalled();
  });
});

describe("getOAuthToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns null for malformed stored token data", async () => {
    const env = createEnv({
      LINEAR_KV: {
        get: vi.fn().mockResolvedValue(JSON.stringify({ access_token: "access-token" })),
        put: vi.fn(),
      } as unknown as KVNamespace,
    });

    await expect(getOAuthToken(env, "org-1")).resolves.toBeNull();
  });

  it("returns null when a refresh response is malformed", async () => {
    const env = createEnv({
      LINEAR_KV: {
        get: vi.fn().mockResolvedValue(
          JSON.stringify({
            access_token: "old-access-token",
            refresh_token: "refresh-token",
            expires_at: Date.now() - 1000,
          })
        ),
        put: vi.fn(),
      } as unknown as KVNamespace,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ access_token: "new-access-token" }),
      })
    );

    await expect(getOAuthToken(env, "org-1")).resolves.toBeNull();
    expect(env.LINEAR_KV.put).not.toHaveBeenCalled();
  });
});
