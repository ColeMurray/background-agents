import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { reposRoutes } from "./repos";
import type * as SharedRoutes from "./shared";
import type { RequestContext } from "./shared";
import { TEST_BACKGROUND_TASK_CONTEXT } from "../router.test-support";

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

vi.mock("../db/repo-metadata", () => ({
  RepoMetadataStore: vi.fn().mockImplementation(function () {
    return { upsert: mockUpsert, getBatch: mockGetBatch };
  }),
}));

vi.mock("@open-inspect/shared/cache-store", () => ({
  createKvCacheStore: vi.fn(() => ({
    delete: mockCacheDelete,
    get: mockCacheGet,
    put: mockCachePut,
  })),
}));

vi.mock("../logger", () => ({
  createLogger: vi.fn(() => mockLogger),
}));

function createContext(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "request-1",
    principal: { kind: "user", userId: "user-1" },
    db: {} as SqlDatabase,
    executionCtx: TEST_BACKGROUND_TASK_CONTEXT,
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

vi.mock("./shared", async () => {
  const actual = await vi.importActual<typeof SharedRoutes>("./shared");
  return {
    ...actual,
    createRouteSourceControlProvider: vi.fn(() => ({
      listRepositories: mockListRepositories,
    })),
  };
});

function getListHandler() {
  const route = reposRoutes.find(
    (candidate) => candidate.method === "GET" && candidate.pattern.test("/repos")
  );
  if (!route) throw new Error("No repository list route found");
  const match = "/repos".match(route.pattern);
  if (!match) throw new Error("List route did not match /repos");
  return { handler: route.handler, match };
}

function getUpdateHandler(path: string) {
  const route = reposRoutes.find((candidate) => candidate.method === "PUT");
  if (!route) throw new Error("No repository metadata update route found");
  const match = path.match(route.pattern);
  if (!match) throw new Error(`Update route did not match ${path}`);
  return { handler: route.handler, match };
}

describe("repository list route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const { handler, match } = getListHandler();
    const ctx = createContext();

    const response = await handler(
      new Request("https://test.local/repos"),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      {
        ...ctx,
        executionCtx: backgroundTasks,
      }
    );

    expect(response.status).toBe(200);
    expect(mockCachePut).toHaveBeenCalledTimes(1);
    expect(backgroundTasks.submissions).toHaveLength(1);
    await backgroundTasks.settle();
    expect(backgroundTasks.failures).toEqual([]);
  });
});

describe("repository metadata routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const path = "/repos/Acme/Widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const responsePromise = handler(
      new Request(`https://test.local${path}`, {
        method: "PUT",
        body: JSON.stringify({ description: "Updated description" }),
      }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
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
    expect(mockCacheDelete).toHaveBeenCalledOnce();
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
    const path = "/repos/acme/widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const response = await handler(
      new Request(`https://test.local${path}`, {
        method: "PUT",
        body: JSON.stringify({ description: "Updated description" }),
      }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
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
    const path = "/repos/acme/widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const response = await handler(
      new Request(`https://test.local${path}`, {
        method: "PUT",
        body: JSON.stringify({ aliases: ["api", 42] }),
      }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid repository metadata" });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it("rejects malformed JSON with the same 400 as an invalid object", async () => {
    const path = "/repos/acme/widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const response = await handler(
      new Request(`https://test.local${path}`, { method: "PUT", body: "{" }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "Invalid repository metadata" });
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(mockCacheDelete).not.toHaveBeenCalled();
  });

  it("persists only schema fields and drops unknown keys", async () => {
    const path = "/repos/acme/widget/metadata";
    const { handler, match } = getUpdateHandler(path);

    const response = await handler(
      new Request(`https://test.local${path}`, {
        method: "PUT",
        body: JSON.stringify({
          description: "Updated description",
          keywords: ["billing"],
          notAField: "dropped",
        }),
      }),
      { REPOS_CACHE: {} as KVNamespace } as Env,
      match,
      createContext()
    );

    expect(response.status).toBe(200);
    expect(mockUpsert).toHaveBeenCalledWith("acme", "widget", {
      description: "Updated description",
      keywords: ["billing"],
    });
  });
});
