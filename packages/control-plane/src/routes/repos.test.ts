import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EnrichedRepository, InstallationRepository, Workspace } from "@open-inspect/shared";
import { reposRoutes } from "./repos";
import type { RequestContext } from "./shared";
import type { Env } from "../types";

const mockProvider = vi.hoisted(() => ({
  listRepositories: vi.fn(),
  listBranches: vi.fn(),
}));

vi.mock("../source-control", () => ({
  SourceControlProviderError: class SourceControlProviderError extends Error {
    constructor(
      message: string,
      readonly errorType: "permanent" | "transient" = "transient",
      readonly httpStatus?: number
    ) {
      super(message);
    }
  },
  createSourceControlProviderFromEnv: vi.fn(() => mockProvider),
}));

vi.mock("../db/repo-metadata", () => ({
  RepoMetadataStore: vi.fn().mockImplementation(function () {
    return {
      getBatch: vi.fn().mockResolvedValue(new Map()),
    };
  }),
}));

vi.mock("../db/workspaces", () => ({
  WorkspaceStore: vi.fn().mockImplementation(function () {
    return {
      resolveWorkspace: vi.fn(async (workspaceId?: string | null): Promise<Workspace | null> => {
        const id = workspaceId ?? "default";
        if (id !== "spi") return null;
        return {
          id,
          key: id,
          name: "SPI",
          status: "active",
          createdAt: 1,
          updatedAt: 1,
        };
      }),
      filterInstalledRepositories: vi.fn(
        async (
          workspaceId: string | null | undefined,
          _provider: string,
          repos: EnrichedRepository[]
        ) => ({
          workspace: {
            id: workspaceId ?? "default",
            key: workspaceId ?? "default",
            name: "SPI",
            status: "active",
            createdAt: 1,
            updatedAt: 1,
          },
          repos: repos
            .filter((repo) => repo.owner.toLowerCase() === "spi")
            .map((repo) => ({ ...repo, workspaceId: workspaceId ?? "default" })),
        })
      ),
    };
  }),
}));

function createEnv(): Env {
  const cache = new Map<string, string>();
  return {
    DB: {} as D1Database,
    SESSION: {} as DurableObjectNamespace,
    REPOS_CACHE: {
      get: vi.fn(async (key: string) => cache.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => {
        cache.set(key, value);
      }),
      list: vi.fn(async () => ({ keys: [], list_complete: true })),
      delete: vi.fn(async (key: string) => {
        cache.delete(key);
      }),
    } as unknown as KVNamespace,
    DEPLOYMENT_NAME: "test",
    TOKEN_ENCRYPTION_KEY: "test-key",
  } as Env;
}

function createCtx(): RequestContext {
  return {
    trace_id: "trace-1",
    request_id: "req-1",
    metrics: {
      d1Queries: [],
      spans: {},
      time: async <T>(_name: string, fn: () => Promise<T>) => fn(),
      summarize: () => ({}),
    },
  };
}

function routeFor(method: string, path: string) {
  for (const route of reposRoutes) {
    if (route.method === method && route.pattern.test(path)) {
      const match = path.match(route.pattern)!;
      return { handler: route.handler, match };
    }
  }
  throw new Error(`No route found for ${method} ${path}`);
}

describe("repos routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProvider.listRepositories.mockResolvedValue([
      {
        id: 1,
        owner: "spi",
        name: "retirement-content",
        fullName: "spi/retirement-content",
        description: null,
        defaultBranch: "main",
        private: true,
        archived: false,
      },
      {
        id: 2,
        owner: "como",
        name: "operations",
        fullName: "como/operations",
        description: null,
        defaultBranch: "main",
        private: true,
        archived: false,
      },
      {
        id: 3,
        owner: "uratex",
        name: "o2c",
        fullName: "uratex/o2c",
        description: null,
        defaultBranch: "main",
        private: true,
        archived: false,
      },
    ] satisfies InstallationRepository[]);
  });

  it("filters /repos by workspaceId", async () => {
    const { handler, match } = routeFor("GET", "/repos");
    const response = await handler(
      new Request("https://test.local/repos?workspaceId=spi"),
      createEnv(),
      match,
      createCtx()
    );

    expect(response.status).toBe(200);
    const body = await response.json<{ repos: Array<{ owner: string; name: string }> }>();
    expect(body.repos).toEqual([
      expect.objectContaining({ owner: "spi", name: "retirement-content" }),
    ]);
  });
});
