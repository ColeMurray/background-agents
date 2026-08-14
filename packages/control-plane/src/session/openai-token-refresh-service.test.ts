import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";
import {
  OpenAITokenBroker,
  OpenAITokenNotConfiguredError,
  OpenAITokenStorageError,
  OpenAITokenUnauthorizedError,
  OpenAITokenUpstreamError,
} from "../auth/openai-token-broker";
import { OpenAITokenRefreshService } from "./openai-token-refresh-service";
import { OpenAITokenRefreshError } from "../auth/openai";

const mockState = vi.hoisted(() => ({
  repoSecrets: new Map<number, Record<string, string>>(),
  globalSecrets: {} as Record<string, string>,
  environmentSecrets: new Map<string, Record<string, string>>(),
  refreshImpl: vi.fn(),
  repoWrites: [] as Array<{
    repoId: number;
    owner: string;
    name: string;
    secrets: Record<string, string>;
  }>,
  globalWrites: [] as Array<Record<string, string>>,
  environmentWrites: [] as Array<{ environmentId: string; secrets: Record<string, string> }>,
  repoWriteImpl: vi.fn(),
  globalWriteImpl: vi.fn(),
  repoReadImpl: vi.fn(),
  globalReadImpl: vi.fn(),
}));

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

vi.mock("../auth/openai", () => {
  class MockOpenAITokenRefreshError extends Error {
    status: number;
    body: string;
    constructor(message: string, status: number, body: string) {
      super(message);
      this.status = status;
      this.body = body;
    }
  }

  return {
    OpenAITokenRefreshError: MockOpenAITokenRefreshError,
    refreshOpenAIToken: (refreshToken: string) => mockState.refreshImpl(refreshToken),
    extractOpenAIAccountId: (tokens: { account_id?: string }) => tokens.account_id,
  };
});

vi.mock("../db/repo-secrets", () => ({
  RepoSecretsStore: class {
    async getDecryptedSecrets(repoId: number): Promise<Record<string, string>> {
      await mockState.repoReadImpl(repoId);
      return mockState.repoSecrets.get(repoId) ?? {};
    }

    async setSecrets(
      repoId: number,
      owner: string,
      name: string,
      secrets: Record<string, string>
    ): Promise<void> {
      await mockState.repoWriteImpl(repoId, owner, name, secrets);
      mockState.repoWrites.push({ repoId, owner, name, secrets });
      const existing = mockState.repoSecrets.get(repoId) ?? {};
      mockState.repoSecrets.set(repoId, { ...existing, ...secrets });
    }
  },
}));

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    async getDecryptedSecrets(): Promise<Record<string, string>> {
      await mockState.globalReadImpl();
      return mockState.globalSecrets;
    }

    async setSecrets(secrets: Record<string, string>): Promise<void> {
      await mockState.globalWriteImpl(secrets);
      mockState.globalWrites.push(secrets);
      mockState.globalSecrets = { ...mockState.globalSecrets, ...secrets };
    }
  },
}));

vi.mock("../db/environment-secrets", () => ({
  EnvironmentSecretsStore: class {
    async getDecryptedSecrets(environmentId: string): Promise<Record<string, string>> {
      return mockState.environmentSecrets.get(environmentId) ?? {};
    }

    async setSecrets(environmentId: string, secrets: Record<string, string>): Promise<void> {
      mockState.environmentWrites.push({ environmentId, secrets });
      const existing = mockState.environmentSecrets.get(environmentId) ?? {};
      mockState.environmentSecrets.set(environmentId, { ...existing, ...secrets });
    }
  },
}));

function createSession(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "session-name-1",
    title: null,
    repo_owner: "acme",
    repo_name: "web",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "openai/gpt-5.1",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user" as const,
    spawn_depth: 0,
    code_server_enabled: 0,
    vnc_enabled: 0,
    total_cost: 0,
    sandbox_settings: null,
    environment_id: null,
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

function createLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createLogger()),
  };
}

describe("OpenAITokenRefreshService", () => {
  beforeEach(() => {
    mockState.repoSecrets.clear();
    mockState.globalSecrets = {};
    mockState.environmentSecrets.clear();
    mockState.repoWrites = [];
    mockState.globalWrites = [];
    mockState.environmentWrites = [];
    mockState.refreshImpl.mockReset();
    mockState.repoWriteImpl.mockReset();
    mockState.repoWriteImpl.mockResolvedValue(undefined);
    mockState.globalWriteImpl.mockReset();
    mockState.globalWriteImpl.mockResolvedValue(undefined);
    mockState.repoReadImpl.mockReset();
    mockState.repoReadImpl.mockResolvedValue(undefined);
    mockState.globalReadImpl.mockReset();
    mockState.globalReadImpl.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns cached repo access token when it is still valid", async () => {
    const repoId = 123;
    mockState.repoSecrets.set(repoId, {
      OPENAI_OAUTH_REFRESH_TOKEN: "refresh-1",
      OPENAI_OAUTH_ACCESS_TOKEN: "cached-access",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 15 * 60 * 1000),
      OPENAI_OAUTH_ACCOUNT_ID: "acct_cached",
    });

    const service = new OpenAITokenRefreshService(
      TEST_DB,
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      accessToken: "cached-access",
      expiresIn: expect.any(Number),
      accountId: "acct_cached",
    });
    expect(mockState.refreshImpl).not.toHaveBeenCalled();
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

    const result = await new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();

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

    const result = await new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();

    expect(result).toEqual({
      accessToken: "global-access-new",
      expiresIn: 1800,
      accountId: "acct_global",
    });
    expect(mockState.refreshImpl).toHaveBeenCalledWith("global-refresh-old");
    expect(mockState.globalWrites).toHaveLength(1);
    expect(mockState.globalWrites[0]).toMatchObject({
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh-new",
      OPENAI_OAUTH_ACCESS_TOKEN: "global-access-new",
      OPENAI_OAUTH_ACCOUNT_ID: "acct_global",
    });
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

    const result = await new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();

    expect(result).toMatchObject({
      accessToken: "global-access-new",
      accountId: "acct_stored",
    });
    expect(mockState.globalWrites[0]).toMatchObject({
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
    mockState.globalWriteImpl
      .mockRejectedValueOnce(new Error("D1 temporarily unavailable"))
      .mockResolvedValueOnce(undefined);

    const promise = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({ accessToken: "global-access-new" });
    expect(mockState.globalWriteImpl).toHaveBeenCalledTimes(2);
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
    mockState.globalWriteImpl.mockRejectedValue(new Error("D1 write failed"));

    const promise = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
    const errorPromise = promise.catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();

    const error = await errorPromise;
    expect(error).toBeInstanceOf(OpenAITokenStorageError);
    expect(error).toHaveProperty(
      "message",
      "OpenAI tokens rotated but could not be saved; reconnect OpenAI OAuth"
    );
    expect(mockState.globalWriteImpl).toHaveBeenCalledTimes(3);
    expect(mockState.globalWrites).toHaveLength(0);
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

    const promise = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({
      accessToken: "global-access-concurrent",
    });
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(1);
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
    const firstBroker = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger());
    const secondBroker = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger());

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

    const result = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
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

    const result = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
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

    const result = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
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
    mockState.globalWriteImpl.mockRejectedValue(new Error("D1 write failed"));

    const result = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
    const rejection = expect(result).rejects.toThrow(OpenAITokenStorageError);
    await vi.runAllTimersAsync();

    await rejection;
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(2);
    expect(mockState.globalWriteImpl).toHaveBeenCalledTimes(3);
  });

  it("throws a not-configured error when refresh token is missing", async () => {
    const service = new OpenAITokenRefreshService(
      TEST_DB,
      "enc-key",
      async () => 123,
      createLogger()
    );

    await expect(service.refresh(createSession())).rejects.toThrow(OpenAITokenNotConfiguredError);
  });

  it("throws a secrets-read error when scoped secrets cannot be read", async () => {
    mockState.globalReadImpl.mockRejectedValue(new Error("D1 read failed"));

    await expect(
      new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal()
    ).rejects.toThrow(OpenAITokenStorageError);
  });

  it("throws an upstream error when token refresh fails unexpectedly", async () => {
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh" };
    mockState.refreshImpl.mockRejectedValue(new Error("upstream connection failed"));

    await expect(
      new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal()
    ).rejects.toThrow(OpenAITokenUpstreamError);
  });

  it("retries with a refresh token written by a concurrent rotation", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "stale-refresh" };
    mockState.refreshImpl
      .mockImplementationOnce(async () => {
        mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "rotated-refresh" };
        throw new OpenAITokenRefreshError("unauthorized", 401, "unauthorized");
      })
      .mockResolvedValueOnce({ access_token: "fresh-access", expires_in: 1800 });

    const result = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ accessToken: "fresh-access" });
    expect(mockState.refreshImpl).toHaveBeenNthCalledWith(2, "rotated-refresh");
  });

  it("continues polling after a transient post-401 secret reread failure", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "stale-refresh" };
    mockState.refreshImpl.mockRejectedValue(
      new OpenAITokenRefreshError("unauthorized", 401, "unauthorized")
    );
    mockState.globalReadImpl
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("D1 reread failed"));

    const result = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
    const rejection = expect(result).rejects.toThrow(OpenAITokenUnauthorizedError);
    await vi.runAllTimersAsync();

    await rejection;
  });

  it("throws a storage error when post-401 secret rereads keep failing", async () => {
    vi.useFakeTimers();
    mockState.globalSecrets = { OPENAI_OAUTH_REFRESH_TOKEN: "stale-refresh" };
    mockState.refreshImpl.mockRejectedValue(
      new OpenAITokenRefreshError("unauthorized", 401, "unauthorized")
    );
    mockState.globalReadImpl
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error("D1 reread failed"));

    const result = new OpenAITokenBroker(TEST_DB, "enc-key", createLogger()).refreshGlobal();
    const rejection = expect(result).rejects.toThrow(OpenAITokenStorageError);
    await vi.runAllTimersAsync();

    await rejection;
    expect(mockState.globalReadImpl).toHaveBeenCalledTimes(5);
  });

  it("throws a secrets-read error when repository scope resolution fails", async () => {
    const service = new OpenAITokenRefreshService(
      TEST_DB,
      "enc-key",
      async () => {
        throw new Error("repository lookup failed");
      },
      createLogger()
    );

    await expect(service.refresh(createSession())).rejects.toThrow(OpenAITokenStorageError);
  });

  it("refreshes token and persists rotated credentials to repo secrets", async () => {
    const repoId = 123;
    mockState.repoSecrets.set(repoId, {
      OPENAI_OAUTH_REFRESH_TOKEN: "refresh-old",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });
    mockState.refreshImpl.mockResolvedValue({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 1800,
      account_id: "acct_new",
    });

    const service = new OpenAITokenRefreshService(
      TEST_DB,
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      accessToken: "access-new",
      expiresIn: 1800,
      accountId: "acct_new",
    });
    expect(mockState.refreshImpl).toHaveBeenCalledWith("refresh-old");
    expect(mockState.repoWrites).toHaveLength(1);
    expect(mockState.repoWrites[0].repoId).toBe(repoId);
    expect(mockState.repoWrites[0].owner).toBe("acme");
    expect(mockState.repoWrites[0].name).toBe("web");
    expect(mockState.repoWrites[0].secrets.OPENAI_OAUTH_REFRESH_TOKEN).toBe("refresh-new");
    expect(mockState.repoWrites[0].secrets.OPENAI_OAUTH_ACCESS_TOKEN).toBe("access-new");
  });

  it("throws an actionable error when rotated session credentials cannot be persisted", async () => {
    vi.useFakeTimers();
    const repoId = 123;
    mockState.repoSecrets.set(repoId, {
      OPENAI_OAUTH_REFRESH_TOKEN: "refresh-old",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });
    mockState.refreshImpl.mockResolvedValue({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 1800,
    });
    mockState.repoWriteImpl.mockRejectedValue(new Error("storage unavailable"));

    const service = new OpenAITokenRefreshService(
      TEST_DB,
      "enc-key",
      async () => repoId,
      createLogger()
    );
    const promise = service.refresh(createSession());
    const errorPromise = promise.catch((caught: unknown) => caught);
    await vi.runAllTimersAsync();

    const error = await errorPromise;
    expect(error).toBeInstanceOf(OpenAITokenStorageError);
    expect(error).toHaveProperty(
      "message",
      "OpenAI tokens rotated but could not be saved; reconnect OpenAI OAuth"
    );
    expect(mockState.repoWriteImpl).toHaveBeenCalledTimes(3);
    expect(mockState.repoWrites).toHaveLength(0);
  });

  it("uses cached token after concurrent rotation when refresh gets 401", async () => {
    vi.useFakeTimers();

    const repoId = 123;
    mockState.repoSecrets.set(repoId, {
      OPENAI_OAUTH_REFRESH_TOKEN: "refresh-stale",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });

    mockState.refreshImpl.mockImplementationOnce(async () => {
      mockState.repoSecrets.set(repoId, {
        OPENAI_OAUTH_REFRESH_TOKEN: "refresh-rotated",
        OPENAI_OAUTH_ACCESS_TOKEN: "access-concurrent",
        OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
        OPENAI_OAUTH_ACCOUNT_ID: "acct_concurrent",
      });
      throw new OpenAITokenRefreshError("unauthorized", 401, "unauthorized");
    });

    const service = new OpenAITokenRefreshService(
      TEST_DB,
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const promise = service.refresh(createSession());
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toEqual({
      accessToken: "access-concurrent",
      expiresIn: expect.any(Number),
      accountId: "acct_concurrent",
    });
    expect(mockState.refreshImpl).toHaveBeenCalledTimes(1);
  });

  it("reads and rotates environment secrets for an environment-launched session", async () => {
    // Repo secrets exist but must be ignored — an environment session sources
    // tokens from the environment, never its members (§6.4/§7.4).
    mockState.repoSecrets.set(123, {
      OPENAI_OAUTH_REFRESH_TOKEN: "repo-refresh-should-be-ignored",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });
    mockState.environmentSecrets.set("env_flagship", {
      OPENAI_OAUTH_REFRESH_TOKEN: "env-refresh-old",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: "0",
    });
    mockState.refreshImpl.mockResolvedValue({
      access_token: "env-access-new",
      refresh_token: "env-refresh-new",
      expires_in: 1800,
      account_id: "acct_env",
    });

    const service = new OpenAITokenRefreshService(
      TEST_DB,
      "enc-key",
      async () => 123,
      createLogger()
    );

    const result = await service.refresh(createSession({ environment_id: "env_flagship" }));

    expect(result).toEqual({
      accessToken: "env-access-new",
      expiresIn: 1800,
      accountId: "acct_env",
    });
    // Refreshed the environment's token, not the repo's.
    expect(mockState.refreshImpl).toHaveBeenCalledWith("env-refresh-old");
    // Rotated credentials persisted back to the environment, never the repo.
    expect(mockState.repoWrites).toHaveLength(0);
    expect(mockState.environmentWrites).toHaveLength(1);
    expect(mockState.environmentWrites[0].environmentId).toBe("env_flagship");
    expect(mockState.environmentWrites[0].secrets.OPENAI_OAUTH_REFRESH_TOKEN).toBe(
      "env-refresh-new"
    );
  });

  it("falls back to global for an environment session with no environment token", async () => {
    const globalCachedTokenTtlMs = 15 * 60 * 1000;
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh",
      OPENAI_OAUTH_ACCESS_TOKEN: "global-access",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + globalCachedTokenTtlMs),
    };

    const service = new OpenAITokenRefreshService(
      TEST_DB,
      "enc-key",
      async () => 123,
      createLogger()
    );

    const result = await service.refresh(createSession({ environment_id: "env_flagship" }));

    expect(result).toMatchObject({ accessToken: "global-access" });
    expect(mockState.refreshImpl).not.toHaveBeenCalled();
  });
});
