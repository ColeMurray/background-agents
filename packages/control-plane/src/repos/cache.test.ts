import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceControlProviderError } from "../source-control/errors";
import type { SqlDatabase } from "../db/sql-database";
import type { Env } from "../types";
import {
  REPOS_CACHE_KEY,
  loadInstallationRepositories,
  readCachedInstallationRepositories,
  reposCacheIdentity,
  type CachedReposList,
} from "./cache";

const { mockGetBatch, mockListRepositories } = vi.hoisted(() => ({
  mockGetBatch: vi.fn(),
  mockListRepositories: vi.fn(),
}));

vi.mock("../source-control/provider-from-env", () => ({
  createSourceControlProviderFromEnv: () => ({ listRepositories: mockListRepositories }),
}));

vi.mock("../db/repo-metadata", () => ({
  RepoMetadataStore: class {
    getBatch = mockGetBatch;
  },
}));

type CacheEnv = Parameters<typeof readCachedInstallationRepositories>[0];

const cacheStore = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
const mockFetch = vi.fn();
const repository: EnrichedRepository = {
  id: 42,
  owner: "acme",
  name: "widgets",
  fullName: "acme/widgets",
  description: null,
  private: true,
  defaultBranch: "main",
  archived: false,
  language: "TypeScript",
  topics: ["widgets"],
  metadata: { aliases: ["widget-service"] },
};

function createEnv(overrides: Partial<CacheEnv> = {}): CacheEnv {
  return {
    REPOS_CACHE: cacheStore,
    SCM_PROVIDER: "github",
    GITHUB_APP_INSTALLATION_ID: "installation-1",
    ...overrides,
  };
}

async function cachedCatalog(env: CacheEnv): Promise<CachedReposList> {
  return {
    repos: [repository],
    cachedAt: "2026-01-01T00:00:00.000Z",
    scmIdentity: await reposCacheIdentity(env),
    freshUntil: 4_102_444_800_000,
  };
}

describe("readCachedInstallationRepositories", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockFetch.mockRejectedValue(new Error("Unexpected network request"));
    vi.stubGlobal("fetch", mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    expect(cacheStore.put).not.toHaveBeenCalled();
    expect(cacheStore.delete).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns the validated enriched catalog using only the existing cache key", async () => {
    const env = createEnv();
    cacheStore.get.mockResolvedValue(await cachedCatalog(env));

    await expect(readCachedInstallationRepositories(env)).resolves.toEqual([repository]);

    expect(cacheStore.get).toHaveBeenCalledExactlyOnceWith(REPOS_CACHE_KEY, "json");
  });

  it.each([0, undefined])("reuses entries with freshUntil %s", async (freshUntil) => {
    const env = createEnv();
    const cached = await cachedCatalog(env);
    if (freshUntil === undefined) delete cached.freshUntil;
    else cached.freshUntil = freshUntil;
    cacheStore.get.mockResolvedValue(cached);

    await expect(readCachedInstallationRepositories(env)).resolves.toEqual([repository]);
    expect(cacheStore.get).toHaveBeenCalledOnce();
  });

  it("accepts an empty validated catalog", async () => {
    const env = createEnv();
    cacheStore.get.mockResolvedValue({ ...(await cachedCatalog(env)), repos: [] });

    await expect(readCachedInstallationRepositories(env)).resolves.toEqual([]);
  });

  it("retains nested GitLab owners and repository IDs", async () => {
    const env = createEnv({
      SCM_PROVIDER: "gitlab",
      GITLAB_NAMESPACE: "acme/platform/services",
      GITLAB_ACCESS_TOKEN: "token-1",
    });
    const nestedRepository = {
      ...repository,
      owner: "acme/platform/services",
      fullName: "acme/platform/services/widgets",
    };
    cacheStore.get.mockResolvedValue({
      ...(await cachedCatalog(env)),
      repos: [nestedRepository],
    });

    await expect(readCachedInstallationRepositories(env)).resolves.toEqual([nestedRepository]);
  });

  it.each([
    {
      name: "a different GitHub installation",
      cachedConfig: {},
      requestedConfig: { GITHUB_APP_INSTALLATION_ID: "installation-2" },
    },
    {
      name: "a different provider",
      cachedConfig: {},
      requestedConfig: { SCM_PROVIDER: "gitlab" },
    },
    {
      name: "a different GitLab namespace",
      cachedConfig: {
        SCM_PROVIDER: "gitlab",
        GITLAB_NAMESPACE: "acme/platform",
        GITLAB_ACCESS_TOKEN: "token-1",
      },
      requestedConfig: { GITLAB_NAMESPACE: "acme/services" },
    },
    {
      name: "a rotated GitLab token",
      cachedConfig: {
        SCM_PROVIDER: "gitlab",
        GITLAB_NAMESPACE: "acme/platform",
        GITLAB_ACCESS_TOKEN: "token-1",
      },
      requestedConfig: { GITLAB_ACCESS_TOKEN: "token-2" },
    },
  ])("fails closed for $name", async ({ cachedConfig, requestedConfig }) => {
    cacheStore.get.mockResolvedValue(await cachedCatalog(createEnv(cachedConfig)));

    const read = readCachedInstallationRepositories(
      createEnv({ ...cachedConfig, ...requestedConfig })
    );

    await expect(read).rejects.toBeInstanceOf(SourceControlProviderError);
    await expect(read).rejects.toMatchObject({
      errorType: "permanent",
      message: "Installation repository catalog cache does not match SCM configuration",
    });
    expect(cacheStore.get).toHaveBeenCalledOnce();
  });

  it.each([null, undefined, "not an object", {}])(
    "fails closed for missing or malformed entries (%j)",
    async (value) => {
      cacheStore.get.mockResolvedValue(value);

      const read = readCachedInstallationRepositories(createEnv());

      await expect(read).rejects.toBeInstanceOf(SourceControlProviderError);
      await expect(read).rejects.toMatchObject({
        errorType: "permanent",
        message: "Installation repository catalog cache is missing or malformed",
      });
      expect(cacheStore.get).toHaveBeenCalledOnce();
    }
  );

  it.each([
    { repos: undefined },
    { repos: [{ ...repository, id: "42" }] },
    { repos: [{ ...repository, owner: undefined }] },
    { repos: [{ ...repository, metadata: { aliases: [42] } }] },
    { cachedAt: undefined },
    { scmIdentity: undefined },
    { freshUntil: "not a number" },
  ])("validates the full existing payload schema (%j)", async (overrides) => {
    const env = createEnv();
    cacheStore.get.mockResolvedValue({ ...(await cachedCatalog(env)), ...overrides });

    const read = readCachedInstallationRepositories(env);

    await expect(read).rejects.toBeInstanceOf(SourceControlProviderError);
    await expect(read).rejects.toMatchObject({ errorType: "permanent" });
    expect(cacheStore.get).toHaveBeenCalledOnce();
  });

  it.each([
    new Error("KV read failed"),
    new SyntaxError("Invalid cached JSON"),
    new SourceControlProviderError("KV timeout", "transient"),
    "non-Error store failure",
  ])("wraps store read failures as permanent errors (%s)", async (cause) => {
    cacheStore.get.mockRejectedValue(cause);

    const read = readCachedInstallationRepositories(createEnv());

    await expect(read).rejects.toBeInstanceOf(SourceControlProviderError);
    await expect(read).rejects.toMatchObject({
      errorType: "permanent",
      message: "Failed to read installation repository catalog cache",
      cause: cause instanceof Error ? cause : undefined,
    });
    expect(cacheStore.get).toHaveBeenCalledOnce();
  });
});

describe("loadInstallationRepositories", () => {
  const db = {} as SqlDatabase;
  const { metadata: _metadata, ...listedRepository } = repository;

  beforeEach(() => {
    vi.resetAllMocks();
    mockGetBatch.mockResolvedValue(new Map());
  });

  it("returns the cached catalog without listing repositories", async () => {
    const env = createEnv();
    cacheStore.get.mockResolvedValue(await cachedCatalog(env));

    await expect(loadInstallationRepositories(env as Env, db)).resolves.toEqual([repository]);

    expect(mockListRepositories).not.toHaveBeenCalled();
    expect(cacheStore.put).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", async () => null],
    ["mismatched", async () => cachedCatalog(createEnv({ GITHUB_APP_INSTALLATION_ID: "other" }))],
  ])("refreshes and repopulates a %s cache", async (_name, cached) => {
    const env = createEnv();
    cacheStore.get.mockResolvedValue(await cached());
    mockListRepositories.mockResolvedValue([listedRepository]);

    await expect(loadInstallationRepositories(env as Env, db)).resolves.toEqual([listedRepository]);

    expect(mockListRepositories).toHaveBeenCalledOnce();
    expect(cacheStore.put).toHaveBeenCalledOnce();
    const [key, body] = cacheStore.put.mock.calls[0];
    expect(key).toBe(REPOS_CACHE_KEY);
    expect(JSON.parse(body)).toMatchObject({
      repos: [listedRepository],
      scmIdentity: await reposCacheIdentity(env),
    });
  });

  it("refreshes when the cache read fails", async () => {
    cacheStore.get.mockRejectedValue(new Error("KV read failed"));
    mockListRepositories.mockResolvedValue([listedRepository]);

    await expect(loadInstallationRepositories(createEnv() as Env, db)).resolves.toEqual([
      listedRepository,
    ]);
  });

  it.each([
    ["transient", new Error("GitHub unavailable")],
    ["permanent", new SourceControlProviderError("GitHub App not configured", "permanent")],
  ])("fails %s when the refresh fails", async (errorType, cause) => {
    cacheStore.get.mockResolvedValue(null);
    mockListRepositories.mockRejectedValue(cause);

    await expect(loadInstallationRepositories(createEnv() as Env, db)).rejects.toMatchObject({
      name: "SourceControlProviderError",
      errorType,
      message: "Failed to load installation repository catalog",
    });
    expect(cacheStore.put).not.toHaveBeenCalled();
  });
});
