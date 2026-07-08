import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { Env } from "../types";
import type { SessionRow } from "./types";
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
}));

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
      return mockState.repoSecrets.get(repoId) ?? {};
    }

    async setSecrets(
      repoId: number,
      owner: string,
      name: string,
      secrets: Record<string, string>
    ): Promise<void> {
      mockState.repoWrites.push({ repoId, owner, name, secrets });
      const existing = mockState.repoSecrets.get(repoId) ?? {};
      mockState.repoSecrets.set(repoId, { ...existing, ...secrets });
    }
  },
}));

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    async getDecryptedSecrets(): Promise<Record<string, string>> {
      return mockState.globalSecrets;
    }

    async setSecrets(secrets: Record<string, string>): Promise<void> {
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
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      ok: true,
      accessToken: "cached-access",
      expiresIn: expect.any(Number),
      accountId: "acct_cached",
    });
    expect(mockState.refreshImpl).not.toHaveBeenCalled();
  });

  it("returns 404 when refresh token is missing in repo and global secrets", async () => {
    const service = new OpenAITokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => 123,
      createLogger()
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      ok: false,
      status: 404,
      error: "OPENAI_OAUTH_REFRESH_TOKEN not configured",
    });
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
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const result = await service.refresh(createSession());

    expect(result).toEqual({
      ok: true,
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
      {} as Env["DB"],
      "enc-key",
      async () => repoId,
      createLogger()
    );

    const promise = service.refresh(createSession());
    await vi.advanceTimersByTimeAsync(500);
    const result = await promise;

    expect(result).toEqual({
      ok: true,
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
      {} as Env["DB"],
      "enc-key",
      async () => 123,
      createLogger()
    );

    const result = await service.refresh(createSession({ environment_id: "env_flagship" }));

    expect(result).toEqual({
      ok: true,
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
    mockState.globalSecrets = {
      OPENAI_OAUTH_REFRESH_TOKEN: "global-refresh",
      OPENAI_OAUTH_ACCESS_TOKEN: "global-access",
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 15 * 60 * 1000),
    };

    const service = new OpenAITokenRefreshService(
      {} as Env["DB"],
      "enc-key",
      async () => 123,
      createLogger()
    );

    const result = await service.refresh(createSession({ environment_id: "env_flagship" }));

    expect(result.ok).toBe(true);
    expect(result).toMatchObject({ accessToken: "global-access" });
    expect(mockState.refreshImpl).not.toHaveBeenCalled();
  });
});
