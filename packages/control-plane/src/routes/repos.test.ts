import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { Env } from "../types";
import { REPOS_CACHE_KEY, reposCacheIdentity, reposRoutes } from "./repos";
import type * as SharedRoutes from "./shared";
import {
  createTestRequestHandler,
  ownerAuthorizationDatabase,
  TEST_BACKGROUND_TASK_CONTEXT,
  TEST_SERVICE_SECRETS,
} from "../router.test-support";

const {
  mockCacheDelete,
  mockCacheGet,
  mockCachePut,
  mockGetBatch,
  mockListRepositories,
  mockLogger,
  mockUpsert,
} = vi.hoisted(() => ({
  mockCacheDelete: vi.fn(),
  mockCacheGet: vi.fn(),
  mockCachePut: vi.fn(),
  mockGetBatch: vi.fn(),
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
      expirationTtl: 3600,
    });
    const cached = JSON.parse(mockCachePut.mock.calls[0][1]) as { scmIdentity: string };
    expect(cached.scmIdentity).toBe(expectedIdentity);
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
