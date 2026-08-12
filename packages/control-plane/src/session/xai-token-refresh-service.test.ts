import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";
import { XaiTokenRefreshError } from "../auth/xai";
import { XaiTokenRefreshService } from "./xai-token-refresh-service";

const state = vi.hoisted(() => ({
  repo: new Map<number, Record<string, string>>(),
  environment: new Map<string, Record<string, string>>(),
  global: {} as Record<string, string>,
  refresh: vi.fn(),
  repoWrites: [] as Record<string, string>[],
  environmentWrites: [] as Record<string, string>[],
  globalWrites: [] as Record<string, string>[],
  failWrites: false,
}));

vi.mock("../auth/xai", () => {
  class MockXaiTokenRefreshError extends Error {
    constructor(
      message: string,
      readonly status: number,
      readonly reason: string
    ) {
      super(message);
    }
  }
  return {
    XaiTokenRefreshError: MockXaiTokenRefreshError,
    refreshXaiToken: (token: string) => state.refresh(token),
  };
});

vi.mock("../db/repo-secrets", () => ({
  RepoSecretsStore: class {
    async getDecryptedSecrets(id: number) {
      return state.repo.get(id) ?? {};
    }
    async setSecrets(id: number, _owner: string, _name: string, secrets: Record<string, string>) {
      if (state.failWrites) throw new Error("write failed");
      state.repoWrites.push(secrets);
      state.repo.set(id, { ...(state.repo.get(id) ?? {}), ...secrets });
    }
  },
}));

vi.mock("../db/environment-secrets", () => ({
  EnvironmentSecretsStore: class {
    async getDecryptedSecrets(id: string) {
      return state.environment.get(id) ?? {};
    }
    async setSecrets(id: string, secrets: Record<string, string>) {
      if (state.failWrites) throw new Error("write failed");
      state.environmentWrites.push(secrets);
      state.environment.set(id, { ...(state.environment.get(id) ?? {}), ...secrets });
    }
  },
}));

vi.mock("../db/global-secrets", () => ({
  GlobalSecretsStore: class {
    async getDecryptedSecrets() {
      return state.global;
    }
    async setSecrets(secrets: Record<string, string>) {
      if (state.failWrites) throw new Error("write failed");
      state.globalWrites.push(secrets);
      state.global = { ...state.global, ...secrets };
    }
  },
}));

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "session-1",
    session_name: "session-1",
    title: null,
    repo_owner: "acme",
    repo_name: "app",
    repo_id: 123,
    base_branch: "main",
    branch_name: null,
    base_sha: null,
    current_sha: null,
    opencode_session_id: null,
    model: "xai/grok-build-0.1",
    reasoning_effort: null,
    status: "active",
    parent_session_id: null,
    spawn_source: "user",
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

const logger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  }) as unknown as Logger;

function service() {
  return new XaiTokenRefreshService({} as SqlDatabase, "key", async () => 123, logger());
}

describe("XaiTokenRefreshService", () => {
  beforeEach(() => {
    state.repo.clear();
    state.environment.clear();
    state.global = {};
    state.refresh.mockReset();
    state.repoWrites = [];
    state.environmentWrites = [];
    state.globalWrites = [];
    state.failWrites = false;
  });

  afterEach(() => vi.useRealTimers());

  it("returns a valid cached access token", async () => {
    state.repo.set(123, {
      XAI_OAUTH_REFRESH_TOKEN: "refresh",
      XAI_OAUTH_ACCESS_TOKEN: "cached",
      XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 15 * 60 * 1000),
    });

    await expect(service().refresh(session())).resolves.toMatchObject({
      ok: true,
      accessToken: "cached",
    });
    expect(state.refresh).not.toHaveBeenCalled();
  });

  it("retains the source refresh token when xAI omits a replacement", async () => {
    state.repo.set(123, { XAI_OAUTH_REFRESH_TOKEN: "refresh-old" });
    state.refresh.mockResolvedValue({ access_token: "access-new", expires_in: 1800 });

    await expect(service().refresh(session())).resolves.toEqual({
      ok: true,
      accessToken: "access-new",
      expiresIn: 1800,
    });
    expect(state.repoWrites[0]).toMatchObject({
      XAI_OAUTH_REFRESH_TOKEN: "refresh-old",
      XAI_OAUTH_ACCESS_TOKEN: "access-new",
    });
  });

  it("returns and persists the default lifetime when xAI omits expires_in", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    state.repo.set(123, { XAI_OAUTH_REFRESH_TOKEN: "refresh-old" });
    state.refresh.mockResolvedValue({
      access_token: "access-new",
      refresh_token: "refresh-new",
    });

    await expect(service().refresh(session())).resolves.toEqual({
      ok: true,
      accessToken: "access-new",
      expiresIn: 3600,
    });
    expect(state.repoWrites[0].XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT).toBe("4600000");
  });

  it("rotates an environment token back to the environment scope", async () => {
    state.repo.set(123, { XAI_OAUTH_REFRESH_TOKEN: "repo-ignored" });
    state.environment.set("env-1", { XAI_OAUTH_REFRESH_TOKEN: "environment-old" });
    state.refresh.mockResolvedValue({
      access_token: "environment-access",
      refresh_token: "environment-new",
    });

    await service().refresh(session({ environment_id: "env-1" }));

    expect(state.refresh).toHaveBeenCalledWith("environment-old");
    expect(state.environmentWrites[0].XAI_OAUTH_REFRESH_TOKEN).toBe("environment-new");
    expect(state.repoWrites).toHaveLength(0);
  });

  it("falls back to and rotates global credentials", async () => {
    state.global = { XAI_OAUTH_REFRESH_TOKEN: "global-old" };
    state.refresh.mockResolvedValue({ access_token: "global-access", refresh_token: "global-new" });

    await service().refresh(session());

    expect(state.globalWrites[0].XAI_OAUTH_REFRESH_TOKEN).toBe("global-new");
    expect(state.repoWrites).toHaveLength(0);
  });

  it("uses a cached token written by a concurrent rotation after a 401", async () => {
    vi.useFakeTimers();
    state.repo.set(123, { XAI_OAUTH_REFRESH_TOKEN: "stale" });
    state.refresh.mockImplementationOnce(async () => {
      state.repo.set(123, {
        XAI_OAUTH_REFRESH_TOKEN: "rotated",
        XAI_OAUTH_ACCESS_TOKEN: "concurrent-access",
        XAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(Date.now() + 60 * 60 * 1000),
      });
      throw new XaiTokenRefreshError("invalid grant", 400, "invalid_grant");
    });

    const result = service().refresh(session());
    await vi.runAllTimersAsync();

    await expect(result).resolves.toMatchObject({ ok: true, accessToken: "concurrent-access" });
    expect(state.refresh).toHaveBeenCalledTimes(1);
  });

  it("returns a refreshed token when rotated tokens cannot be persisted", async () => {
    state.repo.set(123, { XAI_OAUTH_REFRESH_TOKEN: "refresh-old" });
    state.refresh.mockResolvedValue({
      access_token: "access-new",
      refresh_token: "refresh-new",
      expires_in: 3600,
    });
    state.failWrites = true;
    const log = logger();
    const refreshService = new XaiTokenRefreshService(
      {} as SqlDatabase,
      "key",
      async () => 123,
      log
    );

    await expect(refreshService.refresh(session())).resolves.toEqual({
      ok: true,
      accessToken: "access-new",
      expiresIn: 3600,
    });
    expect(log.error).toHaveBeenCalledWith(
      "xAI token refreshed but failed to persist rotated tokens",
      { scope: "repo", error: "write failed" }
    );
  });

  it("returns a bounded failure when the session scope cannot be read", async () => {
    const refreshService = new XaiTokenRefreshService(
      {} as SqlDatabase,
      "key",
      async () => {
        throw new Error("repository lookup failed");
      },
      logger()
    );

    await expect(refreshService.refresh(session())).resolves.toEqual({
      ok: false,
      status: 500,
      error: "Failed to read token state",
    });
  });

  it("returns a bounded failure when token refresh fails unexpectedly", async () => {
    state.repo.set(123, { XAI_OAUTH_REFRESH_TOKEN: "refresh" });
    state.refresh.mockRejectedValue(new Error("upstream connection failed"));

    await expect(service().refresh(session())).resolves.toEqual({
      ok: false,
      status: 502,
      error: "xAI token refresh failed",
    });
  });

  it("retries with a refresh token written by a concurrent rotation", async () => {
    vi.useFakeTimers();
    state.repo.set(123, { XAI_OAUTH_REFRESH_TOKEN: "stale-refresh" });
    state.refresh
      .mockImplementationOnce(async () => {
        state.repo.set(123, { XAI_OAUTH_REFRESH_TOKEN: "rotated-refresh" });
        throw new XaiTokenRefreshError("unauthorized", 401, "unauthorized");
      })
      .mockResolvedValueOnce({ access_token: "fresh-access", expires_in: 1800 });

    const result = service().refresh(session());
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({
      ok: true,
      accessToken: "fresh-access",
      expiresIn: 1800,
    });
    expect(state.refresh).toHaveBeenNthCalledWith(2, "rotated-refresh");
  });

  it("returns unauthorized when the post-401 scope reread fails", async () => {
    vi.useFakeTimers();
    state.repo.set(123, { XAI_OAUTH_REFRESH_TOKEN: "stale-refresh" });
    state.refresh.mockRejectedValue(new XaiTokenRefreshError("unauthorized", 401, "unauthorized"));
    const ensureRepoId = vi
      .fn<() => Promise<number>>()
      .mockResolvedValueOnce(123)
      .mockRejectedValueOnce(new Error("repository reread failed"));
    const refreshService = new XaiTokenRefreshService(
      {} as SqlDatabase,
      "key",
      ensureRepoId,
      logger()
    );

    const result = refreshService.refresh(session());
    await vi.runAllTimersAsync();

    await expect(result).resolves.toEqual({
      ok: false,
      status: 401,
      error: "xAI token refresh failed: unauthorized",
    });
  });
});
