import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import {
  OpenAITokenBroker,
  OpenAITokenNotConfiguredError,
  OpenAITokenStorageError,
  OpenAITokenUnauthorizedError,
  OpenAITokenUpstreamError,
} from "./openai-token-broker";
import { OpenAITokenRefreshError } from "./openai";
import type * as openAIAuthModule from "./openai";

const mockState = vi.hoisted(() => ({
  repoSecrets: new Map<number, Record<string, string>>(),
  globalSecrets: {} as Record<string, string>,
  refreshImpl: vi.fn(),
  globalWrites: [] as Array<Record<string, string>>,
  globalWriteImpl: vi.fn(),
  globalCasImpl: vi.fn(),
  globalReadImpl: vi.fn(),
}));

// Deterministic stand-in for stored ciphertext: equal plaintexts map to equal
// "ciphertexts", so the CAS mock conflicts exactly when the stored value changed.
const cipherOf = (value: string) => `cipher:${value}`;

const TEST_DB: D1Database = {
  prepare(_query: string): D1PreparedStatement {
    throw new Error("Unexpected D1 prepare call");
  },
  async batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    return [];
  },
  async exec(_query: string): Promise<D1ExecResult> {
    throw new Error("Unexpected D1 exec call");
  },
  withSession(): D1DatabaseSession {
    throw new Error("Unexpected D1 session call");
  },
  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
  },
};

vi.mock("./openai", async (importOriginal) => {
  const actual = await importOriginal<typeof openAIAuthModule>();
  return {
    ...actual,
    refreshOpenAIToken: (refreshToken: string) => mockState.refreshImpl(refreshToken),
    extractOpenAIAccountId: (tokens: { account_id?: string }) => tokens.account_id,
  };
});

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    async getDecryptedSecrets(): Promise<Record<string, string>> {
      await mockState.globalReadImpl();
      return mockState.globalSecrets;
    }

    async getSecretWithCiphertext(key: string): Promise<{
      value: string;
      ciphertext: string;
    } | null> {
      const value = mockState.globalSecrets[key];
      return value === undefined ? null : { value, ciphertext: cipherOf(value) };
    }

    async casUpdateSecret(
      key: string,
      expectedCiphertext: string,
      value: string
    ): Promise<boolean> {
      await mockState.globalCasImpl(key, expectedCiphertext, value);
      const current = mockState.globalSecrets[key];
      if (current === undefined || cipherOf(current) !== expectedCiphertext) return false;
      mockState.globalSecrets = { ...mockState.globalSecrets, [key]: value };
      return true;
    }

    async setSecrets(secrets: Record<string, string>): Promise<void> {
      await mockState.globalWriteImpl(secrets);
      mockState.globalWrites.push(secrets);
      mockState.globalSecrets = { ...mockState.globalSecrets, ...secrets };
    }
  },
}));

vi.mock("../db/repo-secrets", () => ({
  RepoSecretsStore: class {
    async getDecryptedSecrets(repoId: number): Promise<Record<string, string>> {
      return mockState.repoSecrets.get(repoId) ?? {};
    }
  },
}));

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  };
}

function broker(): OpenAITokenBroker {
  return new OpenAITokenBroker(TEST_DB, "enc-key", createLogger());
}

describe("OpenAITokenBroker", () => {
  beforeEach(() => {
    mockState.repoSecrets.clear();
    mockState.globalSecrets = {};
    mockState.globalWrites = [];
    mockState.refreshImpl.mockReset();
    mockState.globalWriteImpl.mockReset();
    mockState.globalWriteImpl.mockResolvedValue(undefined);
    mockState.globalCasImpl.mockReset();
    mockState.globalCasImpl.mockResolvedValue(undefined);
    mockState.globalReadImpl.mockReset();
    mockState.globalReadImpl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a cached global access token without consulting session scopes", async () => {
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh",
      OPENAI_OAUTH_ACCESS_TOKEN: "global-cached-access",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 15 * 60 * 1000),
      OPENAI_OAUTH_ACCOUNT_ID: "acct_global",
    };
    mockState.repoSecrets.set(123, {
      OPENAI_OAUTH_REFRESH_TOKEN: "repo-refresh",
      OPENAI_OAUTH_ACCESS_TOKEN: "repo-access",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 15 * 60 * 1000),
    });

    const result = await broker().refreshGlobal();

    expect(result).toEqual({
      accessToken: "global-cached-access",
      expiresIn: expect.any(Number),
      accountId: "acct_global",
    });
    expect(mockState.refreshImpl).not.toHaveBeenCalled();
  });

  it("refreshes and rotates global credentials", async () => {
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-old",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    mockState.refreshImpl.mockResolvedValue({
      access_token: "global-access-new",
      refresh_token: "global-refresh-new",
      expires_in: 1800,
      account_id: "acct_global",
    });

    const result = await broker().refreshGlobal();

    expect(result).toEqual({
      accessToken: "global-access-new",
      expiresIn: 1800,
      accountId: "acct_global",
    });
    expect(mockState.refreshImpl).toHaveBeenCalledWith("global-refresh-old");
    expect(mockState.globalSecrets).toMatchObject({
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-new",
      OPENAI_OAUTH_ACCESS_TOKEN: "global-access-new",
      OPENAI_OAUTH_ACCOUNT_ID: "acct_global",
    });
    expect(mockState.globalWrites).toHaveLength(1);
  });

  it("preserves the stored account id when refresh omits it", async () => {
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-old",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
      OPENAI_OAUTH_ACCOUNT_ID: "acct_stored",
    };
    mockState.refreshImpl.mockResolvedValue({
      access_token: "global-access-new",
      refresh_token: "global-refresh-new",
      expires_in: 1800,
    });

    const result = await broker().refreshGlobal();

    expect(result).toMatchObject({
      accessToken: "global-access-new",
      accountId: "acct_stored",
    });
    expect(mockState.globalSecrets).toMatchObject({
      OPENAI_OAUTH_ACCOUNT_ID: "acct_stored",
    });
  });

  it("retries a transient global persistence failure and returns success after saving", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-old",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    mockState.refreshImpl.mockResolvedValue({
      access_token: "global-access-new",
      refresh_token: "global-refresh-new",
      expires_in: 1800,
    });
    mockState.globalCasImpl
      .mockRejectedValueOnce(new Error("D1 temporarily unavailable"))
      .mockResolvedValueOnce(undefined);

    const promise = broker().refreshGlobal();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ accessToken: "global-access-new" });
    expect(mockState.globalCasImpl).toHaveBeenCalledTimes(2);
    expect(mockState.globalSecrets).toMatchObject({
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-new",
    });
    expect(mockState.globalWrites).toHaveLength(1);
  });

  it("throws an actionable error when rotated global credentials cannot be persisted", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-old",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    mockState.refreshImpl.mockResolvedValue({
      access_token: "global-access-new",
      refresh_token: "global-refresh-new",
      expires_in: 1800,
    });
    mockState.globalCasImpl.mockRejectedValue(new Error("D1 write failed"));

    const promise = broker().refreshGlobal();
    const errorPromise = promise.catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();

    const error = await errorPromise;
    expect(error).toBeInstanceOf(OpenAITokenStorageError);
    expect(error).toHaveProperty(
      "message",
      "OpenAI tokens rotated but could not be saved; reconnect OpenAI OAuth"
    );
    expect(mockState.globalCasImpl).toHaveBeenCalledTimes(3);
    expect(mockState.globalSecrets).toMatchObject({
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-old",
    });
    expect(mockState.globalWrites).toHaveLength(0);
  });

  it("returns its fresh token without persisting when a concurrent rotation wins the CAS", async () => {
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-old",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    mockState.refreshImpl.mockImplementationOnce(async () => {
      // Another isolate rotates and persists between our read and our write.
      mockState.globalSecrets = {
        OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-winner",
        OPENAI_OAUTH_ACCESS_TOKEN: "winner-access",
        OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      };
      return {
        access_token: "loser-access",
        refresh_token: "loser-refresh",
        expires_in: 1800,
      };
    });

    const result = await broker().refreshGlobal();

    expect(result).toMatchObject({ accessToken: "loser-access" });
    expect(mockState.globalSecrets).toMatchObject({
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-winner",
      OPENAI_OAUTH_ACCESS_TOKEN: "winner-access",
    });
    expect(mockState.globalWrites).toHaveLength(0);
  });

  it("keeps its fresh token when the companion write fails after the guard swap", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-old",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    mockState.refreshImpl.mockResolvedValue({
      access_token: "global-access-new",
      refresh_token: "global-refresh-new",
      expires_in: 1800,
    });
    mockState.globalWriteImpl.mockRejectedValue(new Error("companion write failed"));

    const promise = broker().refreshGlobal();
    await vi.runAllTimersAsync();

    // The guard swap already persisted the new refresh token; the retry
    // conflicts against our own write and the fresh token is still returned.
    await expect(promise).resolves.toMatchObject({ accessToken: "global-access-new" });
    expect(mockState.globalSecrets).toMatchObject({
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-new",
    });
    expect(mockState.globalSecrets.OPENAI_OAUTH_ACCESS_TOKEN).toBeUndefined();
  });

  it("uses a concurrently rotated global access token after refresh gets 401", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-stale",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    mockState.refreshImpl.mockImplementationOnce(async () => {
      mockState.globalSecrets = {
        OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-rotated",
        OPENAI_OAUTH_ACCESS_TOKEN: "global-access-concurrent",
        OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      };
      throw new OpenAITokenRefreshError("unauthorized", 401, "unauthorized");
    });

    const promise = broker().refreshGlobal();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({
      accessToken: "global-access-concurrent",
    });
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers from a 400 invalid_grant by using the concurrent rotation's token", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-stale",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    mockState.refreshImpl.mockImplementationOnce(async () => {
      mockState.globalSecrets = {
        OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-rotated",
        OPENAI_OAUTH_ACCESS_TOKEN: "global-access-concurrent",
        OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      };
      throw new OpenAITokenRefreshError(
        "invalid grant",
        400,
        JSON.stringify({ error: "invalid_grant" })
      );
    });

    const promise = broker().refreshGlobal();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({
      accessToken: "global-access-concurrent",
    });
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(1);
  });

  it("recovers from a 400 refresh_token_reused by retrying the rotated token", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "stale-refresh" };
    mockState.refreshImpl
      .mockImplementationOnce(async () => {
        mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "rotated-refresh" };
        throw new OpenAITokenRefreshError(
          "reused",
          400,
          JSON.stringify({ error: "refresh_token_reused" })
        );
      })
      .mockResolvedValueOnce({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 1800,
      });

    const result = broker().refreshGlobal();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ accessToken: "fresh-access" });
    expect(mockState.refreshImpl).toHaveBeenNthCalledWith(2, "rotated-refresh");
  });

  it("treats a 400 without a consumed-token error code as an upstream failure", async () => {
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh" };
    mockState.refreshImpl.mockRejectedValue(
      new OpenAITokenRefreshError("bad request", 400, JSON.stringify({ error: "invalid_request" }))
    );

    await expect(broker().refreshGlobal()).rejects.toThrow(OpenAITokenUpstreamError);
  });

  it("coalesces concurrent refreshes for the same scope and refresh token", async () => {
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-stale",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    let resolveRefresh!: (tokens: {
      access_token: string;
      refresh_token: string;
      expires_in: number;
    }) => void;
    mockState.refreshImpl.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    );
    const firstBroker = broker();
    const secondBroker = broker();

    const first = firstBroker.refreshGlobal();
    const second = secondBroker.refreshGlobal();
    await vi.waitFor(() => expect(mockState.refreshImpl).toHaveBeenCalledOnce());
    resolveRefresh({
      access_token: "global-access-new",
      refresh_token: "global-refresh-new",
      expires_in: 1800,
    });

    await expect(Promise.all([first, second])).resolves.toEqual([
      {
        accessToken: "global-access-new",
        expiresIn: 1800,
        accountId: undefined,
      },
      {
        accessToken: "global-access-new",
        expiresIn: 1800,
        accountId: undefined,
      },
    ]);
    expect(mockState.refreshImpl).toHaveBeenCalledOnce();
    expect(mockState.globalWrites).toHaveLength(1);
  });

  it("waits for a slow concurrent rotation from another isolate", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-stale",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    };
    mockState.refreshImpl.mockImplementationOnce(async () => {
      setTimeout(() => {
        mockState.globalSecrets = {
          OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-rotated",
          OPENAI_OAUTH_ACCESS_TOKEN: "global-access-concurrent",
          OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
        };
      }, 750);
      throw new OpenAITokenRefreshError("unauthorized", 401, "unauthorized");
    });

    const result = broker().refreshGlobal();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({
      accessToken: "global-access-concurrent",
    });
    expect(mockState.refreshImpl).toHaveBeenCalledOnce();
  });

  it("throws an unauthorized error when a concurrently rotated token is also rejected", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-stale" };
    mockState.refreshImpl
      .mockImplementationOnce(async () => {
        mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-rotated" };
        throw new OpenAITokenRefreshError("unauthorized", 401, "unauthorized");
      })
      .mockRejectedValueOnce(new OpenAITokenRefreshError("unauthorized", 401, "unauthorized"));

    const result = broker().refreshGlobal();
    const rejection = expect(result).rejects.toThrow(OpenAITokenUnauthorizedError);
    await vi.runAllTimersAsync();

    await rejection;
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(2);
  });

  it("throws an upstream error when retrying a concurrently rotated token fails", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-stale" };
    mockState.refreshImpl
      .mockImplementationOnce(async () => {
        mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-rotated" };
        throw new OpenAITokenRefreshError("unauthorized", 401, "unauthorized");
      })
      .mockRejectedValueOnce(new Error("upstream connection failed"));

    const result = broker().refreshGlobal();
    const rejection = expect(result).rejects.toThrow(OpenAITokenUpstreamError);
    await vi.runAllTimersAsync();

    await rejection;
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(2);
  });

  it("preserves a persistence error when retrying a concurrently rotated token", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-stale" };
    mockState.refreshImpl
      .mockImplementationOnce(async () => {
        mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-rotated" };
        throw new OpenAITokenRefreshError("unauthorized", 401, "unauthorized");
      })
      .mockResolvedValueOnce({
        access_token: "global-access-new",
        refresh_token: "global-refresh-new",
        expires_in: 1800,
      });
    mockState.globalCasImpl.mockRejectedValue(new Error("D1 write failed"));

    const result = broker().refreshGlobal();
    const rejection = expect(result).rejects.toThrow(OpenAITokenStorageError);
    await vi.runAllTimersAsync();

    await rejection;
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(2);
    expect(mockState.globalCasImpl).toHaveBeenCalledTimes(3);
  });

  it("throws a not-configured error when no scope has a refresh token", async () => {
    await expect(broker().refreshGlobal()).rejects.toThrow(OpenAITokenNotConfiguredError);
  });

  it("throws a secrets-read error when scoped secrets cannot be read", async () => {
    mockState.globalReadImpl.mockRejectedValue(new Error("D1 read failed"));

    await expect(broker().refreshGlobal()).rejects.toThrow(OpenAITokenStorageError);
  });

  it("throws an upstream error when token refresh fails unexpectedly", async () => {
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh" };
    mockState.refreshImpl.mockRejectedValue(new Error("upstream connection failed"));

    await expect(broker().refreshGlobal()).rejects.toThrow(OpenAITokenUpstreamError);
  });

  it("retries with a refresh token written by a concurrent rotation", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "stale-refresh" };
    mockState.refreshImpl
      .mockImplementationOnce(async () => {
        mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "rotated-refresh" };
        throw new OpenAITokenRefreshError("unauthorized", 401, "unauthorized");
      })
      .mockResolvedValueOnce({
        access_token: "fresh-access",
        refresh_token: "fresh-refresh",
        expires_in: 1800,
      });

    const result = broker().refreshGlobal();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ accessToken: "fresh-access" });
    expect(mockState.refreshImpl).toHaveBeenNthCalledWith(2, "rotated-refresh");
  });

  it("continues polling after a transient post-rejection secret reread failure", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "stale-refresh" };
    mockState.refreshImpl.mockRejectedValue(
      new OpenAITokenRefreshError("unauthorized", 401, "unauthorized")
    );
    mockState.globalReadImpl
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("D1 reread failed"));

    const result = broker().refreshGlobal();
    const rejection = expect(result).rejects.toThrow(OpenAITokenUnauthorizedError);
    await vi.runAllTimersAsync();

    await rejection;
  });

  it("throws a storage error when post-rejection secret rereads keep failing", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "stale-refresh" };
    mockState.refreshImpl.mockRejectedValue(
      new OpenAITokenRefreshError("unauthorized", 401, "unauthorized")
    );
    mockState.globalReadImpl
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("D1 reread failed"));

    const result = broker().refreshGlobal();
    const rejection = expect(result).rejects.toThrow(OpenAITokenStorageError);
    await vi.runAllTimersAsync();

    await rejection;
    expect(mockState.globalReadImpl).toHaveBeenCalledTimes(5);
  });
});
