import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";
import {
  OpenAITokenNotConfiguredError,
  OpenAITokenStorageError,
  OpenAITokenRefreshService,
} from "./openai-token-refresh-service";
import { OpenAITokenRefreshError } from "../auth/openai";
import type * as openAIAuthModule from "../auth/openai";

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
  environmentWrites: [] as Array<{ environmentId: string; secrets: Record<string, string> }>,
  repoCasImpl: vi.fn(),
}));

// Deterministic stand-in for stored ciphertext: equal plaintexts map to equal
// "ciphertexts", so the CAS mocks conflict exactly when the stored value changed.
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

vi.mock("../auth/openai", async (importOriginal) => {
  const actual = await importOriginal<typeof openAIAuthModule>();
  return {
    ...actual,
    refreshOpenAIToken: (refreshToken: string) => mockState.refreshImpl(refreshToken),
    extractOpenAIAccountId: (tokens: { account_id?: string }) => tokens.account_id,
  };
});

vi.mock("../db/repo-secrets", () => ({
  RepoSecretsStore: class {
    async getDecryptedSecrets(repoId: number): Promise<Record<string, string>> {
      return mockState.repoSecrets.get(repoId) ?? {};
    }

    async getSecretWithCiphertext(
      repoId: number,
      key: string
    ): Promise<{ value: string; ciphertext: string } | null> {
      const value = mockState.repoSecrets.get(repoId)?.[key];
      return value === undefined ? null : { value, ciphertext: cipherOf(value) };
    }

    async casWriteSecrets(
      repoId: number,
      owner: string,
      name: string,
      guardKey: string,
      expectedCiphertext: string,
      secrets: Record<string, string>
    ): Promise<boolean> {
      await mockState.repoCasImpl(repoId, guardKey, expectedCiphertext, secrets);
      const existing = mockState.repoSecrets.get(repoId) ?? {};
      const current = existing[guardKey];
      if (current === undefined || cipherOf(current) !== expectedCiphertext) return false;
      mockState.repoSecrets.set(repoId, { ...existing, ...secrets });
      mockState.repoWrites.push({ repoId, owner, name, secrets });
      return true;
    }
  },
}));

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    async getDecryptedSecrets(): Promise<Record<string, string>> {
      return mockState.globalSecrets;
    }

    async getSecretWithCiphertext(key: string): Promise<{
      value: string;
      ciphertext: string;
    } | null> {
      const value = mockState.globalSecrets[key];
      return value === undefined ? null : { value, ciphertext: cipherOf(value) };
    }

    async casWriteSecrets(
      guardKey: string,
      expectedCiphertext: string,
      secrets: Record<string, string>
    ): Promise<boolean> {
      const current = mockState.globalSecrets[guardKey];
      if (current === undefined || cipherOf(current) !== expectedCiphertext) return false;
      mockState.globalSecrets = { ...mockState.globalSecrets, ...secrets };
      return true;
    }
  },
}));

vi.mock("../db/environment-secrets", () => ({
  EnvironmentSecretsStore: class {
    async getDecryptedSecrets(environmentId: string): Promise<Record<string, string>> {
      return mockState.environmentSecrets.get(environmentId) ?? {};
    }

    async getSecretWithCiphertext(
      environmentId: string,
      key: string
    ): Promise<{ value: string; ciphertext: string } | null> {
      const value = mockState.environmentSecrets.get(environmentId)?.[key];
      return value === undefined ? null : { value, ciphertext: cipherOf(value) };
    }

    async casWriteSecrets(
      environmentId: string,
      guardKey: string,
      expectedCiphertext: string,
      secrets: Record<string, string>
    ): Promise<boolean> {
      const existing = mockState.environmentSecrets.get(environmentId) ?? {};
      const current = existing[guardKey];
      if (current === undefined || cipherOf(current) !== expectedCiphertext) return false;
      mockState.environmentSecrets.set(environmentId, { ...existing, ...secrets });
      mockState.environmentWrites.push({ environmentId, secrets });
      return true;
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
    mockState.environmentWrites = [];
    mockState.refreshImpl.mockReset();
    mockState.repoCasImpl.mockReset();
    mockState.repoCasImpl.mockResolvedValue(undefined);
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

  it("throws a not-configured error when refresh token is missing", async () => {
    const service = new OpenAITokenRefreshService(
      TEST_DB,
      "enc-key",
      async () => 123,
      createLogger()
    );

    await expect(service.refresh(createSession())).rejects.toThrow(OpenAITokenNotConfiguredError);
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
    expect(mockState.repoSecrets.get(repoId)).toMatchObject({
      OPENAI_OAUTH_REFRESH_TOKEN: "refresh-new",
      OPENAI_OAUTH_ACCESS_TOKEN: "access-new",
      OPENAI_OAUTH_ACCOUNT_ID: "acct_new",
    });
    expect(mockState.repoWrites).toHaveLength(1);
    expect(mockState.repoWrites[0]).toMatchObject({ repoId, owner: "acme", name: "web" });
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
    mockState.repoCasImpl.mockRejectedValue(new Error("storage unavailable"));

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
    expect(mockState.repoCasImpl).toHaveBeenCalledTimes(3);
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
    expect(mockState.environmentSecrets.get("env_flagship")).toMatchObject({
      OPENAI_OAUTH_REFRESH_TOKEN: "env-refresh-new",
      OPENAI_OAUTH_ACCESS_TOKEN: "env-access-new",
    });
    expect(mockState.environmentWrites).toHaveLength(1);
    expect(mockState.environmentWrites[0].environmentId).toBe("env_flagship");
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
