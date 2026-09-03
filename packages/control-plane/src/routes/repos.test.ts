import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthenticateModule from "../auth/authenticate";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import type { Env } from "../types";
import { reposRoutes } from "./repos";
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
    REPOS_CACHE: {} as KVNamespace,
  } as unknown as Env;
}

/** Requests carry the trace id the handlers log under. */
function request(path: string, init?: RequestInit): Request {
  return new Request(`https://test.local${path}`, {
    ...init,
    headers: { "x-trace-id": "trace-1", ...(init?.headers ?? {}) },
  });
}

function updateMetadata(path: string, body: string): Promise<Response> {
  return handleRequest(
    request(path, { method: "PUT", body }),
    createEnv(),
    TEST_BACKGROUND_TASK_CONTEXT
  );
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
