import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { Env } from "../types";
import { SourceControlProviderError } from "../source-control";
import { REPOS_CACHE_KEY, reposCacheIdentity, reposRoutes } from "./repos";
import type * as SharedRoutes from "./shared";
import {
  createTestRequestHandler,
  authorizationDatabase,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";

const {
  mockCacheDelete,
  mockCacheGet,
  mockCachePut,
  mockGetBatch,
  mockListBranches,
  mockListRepositories,
  mockLogger,
  mockUpsert,
} = vi.hoisted(() => ({
  mockCacheDelete: vi.fn(),
  mockCacheGet: vi.fn(),
  mockCachePut: vi.fn(),
  mockGetBatch: vi.fn(),
  mockListBranches: vi.fn(),
  mockListRepositories: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  mockUpsert: vi.fn(),
}));

const mocks = vi.hoisted(() => ({ authenticate: vi.fn() }));

vi.mock("../auth/authenticate", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthenticateModule>()),
  authenticate: mocks.authenticate,
}));

vi.mock("../db/repo-metadata", () => ({
  RepoMetadataStore: vi.fn().mockImplementation(function () {
    return { upsert: mockUpsert, getBatch: mockGetBatch };
  }),
}));

vi.mock("../logger", () => ({
  createLogger: vi.fn(() => mockLogger),
}));

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof SharedRoutes>("./shared");
  return {
    ...actual,
    createRouteSourceControlProvider: vi.fn(() => ({
      listBranches: mockListBranches,
      listRepositories: mockListRepositories,
    })),
  };
});

const handleRequest = createTestRequestHandler([reposRoutes]);

function createEnv(): Env {
  return {
    ...TEST_SERVICE_SECRETS,
    SCM_PROVIDER: "github",
    DB: ownerAuthorizationDatabase(),
    REPOS_CACHE: { delete: mockCacheDelete, get: mockCacheGet, put: mockCachePut },
  } as unknown as Env;
}

/** Requests carry the trace id the handlers log under. */
function request(path: string, init?: RequestInit): Request {
  return new Request(`https://test.local${path}`, {
    ...init,
    headers: { "x-trace-id": "trace-1", ...(init?.headers ?? {}) },
  });
}

function updateMetadata(path: string, body: string, env = createEnv()): Promise<Response> {
  return handleRequest(request(path, { method: "PUT", body }), env, TEST_BACKGROUND_TASK_CONTEXT);
}

describe("repository list route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mockCacheGet.mockResolvedValue(null);
    mockCachePut.mockResolvedValue(undefined);
    mockGetBatch.mockResolvedValue(new Map());
    mockListRepositories.mockResolvedValue([
      {
        id: 1,
        owner: "acme",
        name: "widgets",
        fullName: "acme/widgets",
        description: null,
        private: true,
        archived: false,
        defaultBranch: "main",
      },
    ]);
  });

  it("keeps the cold-cache refresh alive when the client disconnects", async () => {
    // A cold cache is populated synchronously. The web proxy aborts at
    // CONTROL_PLANE_FETCH_TIMEOUT_MS, which cancels the worker — so unless the
    // refresh is registered with waitUntil, the KV write never lands and every
    // later request repeats the same slow path against an empty cache.
    const backgroundTasks = createTestBackgroundTasks();

    const response = await handleRequest(request("/repos"), createEnv(), backgroundTasks);

    expect(response.status).toBe(200);
    expect(mockCachePut).toHaveBeenCalledTimes(1);
    expect(backgroundTasks.submissions).toHaveLength(1);
    await backgroundTasks.settle();
    expect(backgroundTasks.failures).toEqual([]);
  });

  it("fingerprints the effective SCM catalogue identity", async () => {
    const githubEnv = {
      ...createEnv(),
      GITHUB_APP_INSTALLATION_ID: "installation-1",
    };
    const otherGitHubEnv = {
      ...githubEnv,
      GITHUB_APP_INSTALLATION_ID: "installation-2",
    };
    const gitlabEnv = {
      ...createEnv(),
      SCM_PROVIDER: "gitlab",
      GITLAB_NAMESPACE: "acme/platform",
      GITLAB_ACCESS_TOKEN: "token-1",
    };
    const otherGitlabEnv = { ...gitlabEnv, GITLAB_NAMESPACE: "acme/services" };
    const rotatedGitlabTokenEnv = { ...gitlabEnv, GITLAB_ACCESS_TOKEN: "token-2" };

    const githubIdentity = await reposCacheIdentity(githubEnv);
    const gitlabIdentity = await reposCacheIdentity(gitlabEnv);

    expect(githubIdentity).toMatch(/^[0-9a-f]{64}$/);
    expect(githubIdentity).not.toContain("installation-1");
    await expect(reposCacheIdentity(otherGitHubEnv)).resolves.not.toBe(githubIdentity);
    expect(gitlabIdentity).not.toBe(githubIdentity);
    await expect(reposCacheIdentity(otherGitlabEnv)).resolves.not.toBe(gitlabIdentity);
    await expect(reposCacheIdentity(rotatedGitlabTokenEnv)).resolves.not.toBe(gitlabIdentity);
  });

  it("stores the SCM identity in the singleton cache entry", async () => {
    const env = { ...createEnv(), GITHUB_APP_INSTALLATION_ID: "installation-1" };
    const expectedIdentity = await reposCacheIdentity(env);

    const response = await handleRequest(request("/repos"), env, createTestBackgroundTasks());

    expect(response.status).toBe(200);
    expect(mockCacheGet).toHaveBeenCalledWith(REPOS_CACHE_KEY, "json");
    expect(mockCachePut).toHaveBeenCalledWith(REPOS_CACHE_KEY, expect.any(String), {
      ttlMs: 3_600_000,
    });
    const cached = JSON.parse(mockCachePut.mock.calls[0][1]) as { scmIdentity: string };
    expect(cached.scmIdentity).toBe(expectedIdentity);
  });

  it("treats a malformed singleton cache entry as a miss", async () => {
    const env = createEnv();
    mockCacheGet.mockResolvedValue({
      repos: [{ id: "not-a-number" }],
      cachedAt: new Date().toISOString(),
      scmIdentity: await reposCacheIdentity(env),
      freshUntil: Date.now() + 60_000,
    });

    const response = await handleRequest(request("/repos"), env, createTestBackgroundTasks());

    expect(response.status).toBe(200);
    expect(mockListRepositories).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({ cached: false });
  });

  it("globally invalidates enriched metadata across SCM configuration changes", async () => {
    let cached: unknown = null;
    let description = "Original description";
    mockCacheGet.mockImplementation(async () => cached);
    mockCachePut.mockImplementation(async (_key, value) => {
      cached = JSON.parse(value);
    });
    mockCacheDelete.mockImplementation(async () => {
      cached = null;
    });
    mockGetBatch.mockImplementation(async () => new Map([["acme/widgets", { description }]]));
    mockUpsert.mockImplementation(async (_owner, _name, metadata) => {
      description = metadata.description;
    });
    const installationOne = {
      ...createEnv(),
      GITHUB_APP_INSTALLATION_ID: "installation-1",
    };
    const installationTwo = {
      ...createEnv(),
      GITHUB_APP_INSTALLATION_ID: "installation-2",
    };

    await handleRequest(request("/repos"), installationOne, createTestBackgroundTasks());
    await handleRequest(request("/repos"), installationTwo, createTestBackgroundTasks());
    await handleRequest(request("/repos"), installationOne, createTestBackgroundTasks());
    await updateMetadata(
      "/repos/acme/widgets/metadata",
      JSON.stringify({ description: "Updated description" }),
      installationTwo
    );
    const response = await handleRequest(
      request("/repos"),
      installationOne,
      createTestBackgroundTasks()
    );

    expect(mockCacheDelete).toHaveBeenCalledWith(REPOS_CACHE_KEY);
    expect(mockListRepositories).toHaveBeenCalledTimes(4);
    await expect(response.json()).resolves.toMatchObject({
      cached: false,
      repos: [{ metadata: { description: "Updated description" } }],
    });
  });
});

describe("repository branch route", () => {
  const cacheKey = "repos:branches:v1:acme/widgets";
  const branches = [{ name: "main" }, { name: "feature/widgets" }];
  const now = Date.parse("2026-01-01T00:00:00.000Z");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mockCacheGet.mockResolvedValue(null);
    mockCachePut.mockResolvedValue(undefined);
    mockListBranches.mockResolvedValue(branches);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function cacheEntry(env: Env, freshUntil = now + 60_000) {
    return {
      branches,
      cachedAt: new Date(now).toISOString(),
      scmIdentity: await reposCacheIdentity(env),
      freshUntil,
    };
  }

  it("populates a miss once, keeps the refresh alive, and times cache and SCM access", async () => {
    const env = createEnv();
    const backgroundTasks = createTestBackgroundTasks();
    let resolveBranches!: (value: { name: string }[]) => void;
    mockListBranches.mockImplementation(
      () => new Promise<{ name: string }[]>((resolve) => (resolveBranches = resolve))
    );

    const pending = handleRequest(request("/repos/Acme/Widgets/branches"), env, backgroundTasks);
    await vi.waitFor(() => expect(backgroundTasks.submissions).toHaveLength(1));
    expect(mockCachePut).not.toHaveBeenCalled();
    vi.setSystemTime(now);
    resolveBranches(branches);
    await backgroundTasks.settle();
    expect(mockCachePut).toHaveBeenCalledOnce();
    const response = await pending;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      branches,
      cached: false,
      cachedAt: new Date(now).toISOString(),
    });
    expect(mockListBranches).toHaveBeenCalledExactlyOnceWith({ owner: "Acme", name: "Widgets" });
    expect(mockCacheGet).toHaveBeenCalledExactlyOnceWith(cacheKey, "json");
    expect(mockCachePut).toHaveBeenCalledExactlyOnceWith(
      cacheKey,
      JSON.stringify(await cacheEntry(env)),
      { ttlMs: 3_600_000 }
    );
    expect(backgroundTasks.submissions).toHaveLength(1);
    await backgroundTasks.settle();
    expect(backgroundTasks.failures).toEqual([]);
    expect(mockLogger.info).toHaveBeenCalledWith(
      "http.request",
      expect.objectContaining({ kv_read_ms: expect.any(Number), scm_api_ms: expect.any(Number) })
    );
  });

  it("serves the next request from cache throughout the fresh window", async () => {
    const env = createEnv();
    mockCachePut.mockImplementation(async (_key, value: string) => {
      mockCacheGet.mockResolvedValue(JSON.parse(value));
    });
    await handleRequest(request("/repos/acme/widgets/branches"), env, createTestBackgroundTasks());
    mockListBranches.mockClear();
    mockLogger.info.mockClear();
    vi.setSystemTime(now + 59_999);
    const backgroundTasks = createTestBackgroundTasks();

    const response = await handleRequest(
      request("/repos/acme/widgets/branches"),
      env,
      backgroundTasks
    );

    await expect(response.json()).resolves.toEqual({
      branches,
      cached: true,
      cachedAt: new Date(now).toISOString(),
    });
    expect(mockListBranches).not.toHaveBeenCalled();
    expect(backgroundTasks.submissions).toHaveLength(0);
    const requestLog = mockLogger.info.mock.calls.find(
      ([message]) => message === "http.request"
    )?.[1];
    expect(requestLog).toHaveProperty("kv_read_ms", expect.any(Number));
    expect(requestLog).not.toHaveProperty("scm_api_ms");
  });

  it("serves a stale entry immediately and schedules one refresh at the freshness boundary", async () => {
    const env = createEnv();
    const entry = await cacheEntry(env, now);
    mockCacheGet.mockResolvedValue(entry);
    let resolveBranches!: (value: { name: string }[]) => void;
    mockListBranches.mockImplementation(
      () => new Promise<{ name: string }[]>((resolve) => (resolveBranches = resolve))
    );
    const backgroundTasks = createTestBackgroundTasks();

    const response = await handleRequest(
      request("/repos/acme/widgets/branches"),
      env,
      backgroundTasks
    );

    await expect(response.json()).resolves.toEqual({
      branches,
      cached: true,
      cachedAt: entry.cachedAt,
    });
    expect(backgroundTasks.submissions).toHaveLength(1);
    expect(mockListBranches).toHaveBeenCalledOnce();
    expect(mockCachePut).not.toHaveBeenCalled();
    expect(mockLogger.info).not.toHaveBeenCalledWith(
      "repos_branches_cache.fetch",
      expect.anything()
    );
    vi.setSystemTime(now + 250);
    resolveBranches([{ name: "new-branch" }]);
    await backgroundTasks.settle();
    expect(backgroundTasks.failures).toEqual([]);
    expect(mockCachePut).toHaveBeenCalledOnce();
    expect(JSON.parse(mockCachePut.mock.calls[0][1])).toMatchObject({
      branches: [{ name: "new-branch" }],
      freshUntil: now + 250 + 60_000,
    });
    expect(mockLogger.info).toHaveBeenCalledWith("repos_branches_cache.fetch", {
      event: "repos_branches_cache.fetch",
      trace_id: "trace-1",
      repo_owner: "acme",
      repo_name: "widgets",
      scm_api_ms: 250,
    });
  });

  it.each(["cold", "stale"])(
    "coalesces concurrent %s refreshes until they settle",
    async (state) => {
      const env = createEnv();
      if (state === "stale") mockCacheGet.mockResolvedValue(await cacheEntry(env, now));
      let resolveBranches!: (value: { name: string }[]) => void;
      mockListBranches.mockReturnValue(
        new Promise<{ name: string }[]>((resolve) => (resolveBranches = resolve))
      );
      const tasks = [createTestBackgroundTasks(), createTestBackgroundTasks()];
      const responses = [
        handleRequest(request("/repos/acme/widgets/branches"), env, tasks[0]),
        handleRequest(request("/repos/Acme/Widgets/branches"), env, tasks[1]),
      ];

      try {
        await vi.waitFor(() => tasks.forEach((task) => expect(task.submissions).toHaveLength(1)));
        expect(mockListBranches).toHaveBeenCalledOnce();
        expect(mockCachePut).not.toHaveBeenCalled();
        if (state === "stale") {
          for (const response of await Promise.all(responses)) expect(response.status).toBe(200);
        }
      } finally {
        resolveBranches(branches);
        await Promise.all(tasks.map((task) => task.settle()));
        await Promise.all(responses);
      }

      expect(mockCachePut).toHaveBeenCalledOnce();
      mockListBranches.mockResolvedValue(branches);
      const retryTasks = createTestBackgroundTasks();
      await handleRequest(request("/repos/acme/widgets/branches"), env, retryTasks);
      await retryTasks.settle();
      expect(mockListBranches).toHaveBeenCalledTimes(2);
    }
  );

  it.each(["repository", "SCM identity"])("keeps refreshes separate by %s", async (scope) => {
    const env = createEnv();
    let resolveBranches!: (value: { name: string }[]) => void;
    mockListBranches.mockReturnValue(
      new Promise<{ name: string }[]>((resolve) => (resolveBranches = resolve))
    );
    const tasks = [createTestBackgroundTasks(), createTestBackgroundTasks()];
    const responses = [
      handleRequest(request("/repos/acme/widgets/branches"), env, tasks[0]),
      handleRequest(
        request(
          scope === "repository" ? "/repos/acme/other/branches" : "/repos/acme/widgets/branches"
        ),
        scope === "SCM identity"
          ? { ...env, GITHUB_APP_INSTALLATION_ID: "other-installation" }
          : env,
        tasks[1]
      ),
    ];

    try {
      await vi.waitFor(() => tasks.forEach((task) => expect(task.submissions).toHaveLength(1)));
      expect(mockListBranches).toHaveBeenCalledTimes(2);
    } finally {
      resolveBranches(branches);
      await Promise.all(tasks.map((task) => task.settle()));
      await Promise.all(responses);
    }
    expect(mockCachePut).toHaveBeenCalledTimes(2);
  });

  it("retries after a shared refresh fails", async () => {
    const env = createEnv();
    let rejectBranches!: (reason: Error) => void;
    mockListBranches.mockReturnValue(
      new Promise<{ name: string }[]>((_resolve, reject) => (rejectBranches = reject))
    );
    const tasks = [createTestBackgroundTasks(), createTestBackgroundTasks()];
    const responses = tasks.map((task) =>
      handleRequest(request("/repos/acme/widgets/branches"), env, task)
    );

    try {
      await vi.waitFor(() => tasks.forEach((task) => expect(task.submissions).toHaveLength(1)));
      expect(mockListBranches).toHaveBeenCalledOnce();
    } finally {
      rejectBranches(new Error("Provider unavailable"));
      await Promise.all(tasks.map((task) => task.settle()));
      await Promise.all(responses);
    }
    for (const response of await Promise.all(responses)) expect(response.status).toBe(500);
    expect(mockCachePut).not.toHaveBeenCalled();
    expect(mockLogger.info).toHaveBeenCalledWith(
      "repos_branches_cache.fetch",
      expect.objectContaining({ scm_api_ms: expect.any(Number) })
    );

    mockListBranches.mockResolvedValue(branches);
    const retry = await handleRequest(
      request("/repos/acme/widgets/branches"),
      env,
      createTestBackgroundTasks()
    );
    expect(retry.status).toBe(200);
    expect(mockListBranches).toHaveBeenCalledTimes(2);
    expect(mockCachePut).toHaveBeenCalledOnce();
  });

  it("treats an SCM identity mismatch as a miss", async () => {
    const env = createEnv();
    mockCacheGet.mockResolvedValue(
      await cacheEntry({ ...env, GITHUB_APP_INSTALLATION_ID: "other-installation" })
    );

    const response = await handleRequest(
      request("/repos/acme/widgets/branches"),
      env,
      createTestBackgroundTasks()
    );

    await expect(response.json()).resolves.toMatchObject({ cached: false });
    expect(mockListBranches).toHaveBeenCalledOnce();
    expect(JSON.parse(mockCachePut.mock.calls[0][1]).scmIdentity).toBe(
      await reposCacheIdentity(env)
    );
  });

  it("treats a malformed entry as a miss", async () => {
    const env = createEnv();
    mockCacheGet.mockResolvedValue({ ...(await cacheEntry(env)), branches: [{ name: 42 }] });

    const response = await handleRequest(
      request("/repos/acme/widgets/branches"),
      env,
      createTestBackgroundTasks()
    );

    await expect(response.json()).resolves.toMatchObject({ cached: false, branches });
    expect(mockListBranches).toHaveBeenCalledOnce();
  });

  it.each([
    { failure: new Error("Provider unavailable"), message: "Failed to list branches" },
    {
      failure: new SourceControlProviderError("Not configured", "permanent"),
      message: "SCM provider not configured",
    },
    {
      failure: new SourceControlProviderError("Not found", "permanent", 404),
      message: "Failed to list branches",
    },
  ])(
    "preserves synchronous errors without caching them ($message)",
    async ({ failure, message }) => {
      mockListBranches.mockRejectedValue(failure);
      const backgroundTasks = createTestBackgroundTasks();

      const response = await handleRequest(
        request("/repos/acme/widgets/branches"),
        createEnv(),
        backgroundTasks
      );

      expect(response.status).toBe(500);
      await expect(response.json()).resolves.toEqual({ error: message });
      await backgroundTasks.settle();
      expect(mockCachePut).not.toHaveBeenCalled();
      expect(mockCacheDelete).not.toHaveBeenCalled();
    }
  );

  it("logs a failed background refresh and leaves the stale entry intact", async () => {
    const env = createEnv();
    const entry = await cacheEntry(env, now - 1);
    mockCacheGet.mockResolvedValue(entry);
    const failure = new Error("Provider unavailable");
    mockListBranches.mockRejectedValue(failure);
    const backgroundTasks = createTestBackgroundTasks();

    const response = await handleRequest(
      request("/repos/acme/widgets/branches"),
      env,
      backgroundTasks
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      branches,
      cached: true,
      cachedAt: entry.cachedAt,
    });
    await backgroundTasks.settle();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      "Failed to refresh branches cache",
      expect.objectContaining({ error: failure })
    );
    expect(mockCachePut).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it.each(["read", "write"])("returns branches despite a cache %s failure", async (operation) => {
    if (operation === "read") mockCacheGet.mockRejectedValue(new Error("Cache unavailable"));
    else mockCachePut.mockRejectedValue(new Error("Cache unavailable"));

    const response = await handleRequest(
      request("/repos/acme/widgets/branches"),
      createEnv(),
      createTestBackgroundTasks()
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ branches, cached: false });
    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("checks route permissions before reading the cache", async () => {
    const env = { ...createEnv(), DB: authorizationDatabase({ permissions: [] }) };

    const response = await handleRequest(
      request("/repos/acme/widgets/branches"),
      env,
      createTestBackgroundTasks()
    );

    expect(response.status).toBe(403);
    expect(mockCacheGet).not.toHaveBeenCalled();
    expect(mockListBranches).not.toHaveBeenCalled();
  });
});

describe("repository metadata routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authenticate.mockImplementation(async (request: Request) => ({
      principal: { kind: "user", userId: "user-1" },
      request,
    }));
    mockUpsert.mockResolvedValue(undefined);
    mockCacheDelete.mockResolvedValue(undefined);
  });

  it("returns success when cache invalidation fails after the metadata update commits", async () => {
    let resolveUpsert!: () => void;
    mockUpsert.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveUpsert = resolve;
        })
    );
    const cacheError = new Error("KV unavailable");
    mockCacheDelete.mockRejectedValue(cacheError);
    const responsePromise = updateMetadata(
      "/repos/Acme/Widget/metadata",
      JSON.stringify({ description: "Updated description" })
    );

    await vi.waitFor(() => expect(mockUpsert).toHaveBeenCalledOnce());
    expect(mockCacheDelete).not.toHaveBeenCalled();
    resolveUpsert();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "updated",
      repo: "acme/widget",
      metadata: { description: "Updated description" },
    });
    expect(mockUpsert).toHaveBeenCalledWith("Acme", "Widget", {
      description: "Updated description",
    });
    expect(mockCacheDelete).toHaveBeenCalledWith(REPOS_CACHE_KEY);
    expect(mockLogger.warn).toHaveBeenCalledWith("Failed to invalidate repos cache", {
      trace_id: "trace-1",
      error: cacheError,
      repo_owner: "Acme",
      repo_name: "Widget",
    });
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("returns an error and skips cache invalidation when the metadata update fails", async () => {
    const updateError = new Error("D1 unavailable");
    mockUpsert.mockRejectedValue(updateError);
    const response = await updateMetadata(
      "/repos/acme/widget/metadata",
      JSON.stringify({ description: "Updated description" })
    );

    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "Failed to update metadata" });
    expect(mockCacheDelete).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith("Failed to update repo metadata", {
      error: updateError,
    });
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("rejects malformed metadata before persistence", async () => {
    const response = await updateMetadata(
      "/repos/acme/widget/metadata",
      JSON.stringify({ aliases: ["api", 42] })
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid repository metadata" });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with the same 400 as an invalid object", async () => {
    const response = await updateMetadata("/repos/acme/widget/metadata", "{");

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid repository metadata" });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it("persists only schema fields and drops unknown keys", async () => {
    const response = await updateMetadata(
      "/repos/acme/widget/metadata",
      JSON.stringify({
        description: "Updated description",
        keywords: ["billing"],
        notAField: "dropped",
      })
    );

    expect(response.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith("acme", "widget", {
      description: "Updated description",
      keywords: ["billing"],
    });
  });
});
