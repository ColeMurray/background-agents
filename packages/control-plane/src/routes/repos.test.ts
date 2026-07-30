import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import { reposRoutes } from "./repos";
import type { RequestContext } from "./shared";

const { mockCacheDelete, mockLogger, mockUpsert } = vi.hoisted(() => ({
  mockCacheDelete: vi.fn(),
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
    return { upsert: mockUpsert };
  }),
}));

vi.mock("@open-inspect/shared/cache-store", () => ({
  createKvCacheStore: vi.fn(() => ({ delete: mockCacheDelete })),
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
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function getUpdateHandler(path: string) {
  const route = reposRoutes.find((candidate) => candidate.method === "PUT");
  if (!route) throw new Error("No repository metadata update route found");
  const match = path.match(route.pattern);
  if (!match) throw new Error(`Update route did not match ${path}`);
  return { handler: route.handler, match };
}

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
});
