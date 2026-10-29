import type { EnrichedRepository } from "@open-inspect/shared/types/repository-catalog";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SourceControlProviderError } from "../source-control/errors";
import {
  REPOS_CACHE_KEY,
  readCachedInstallationRepositories,
  reposCacheIdentity,
  type CachedReposList,
} from "./cache";

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

    await expect(
      readCachedInstallationRepositories(createEnv({ ...cachedConfig, ...requestedConfig }))
    ).rejects.toMatchObject({
      errorType: "permanent",
      message: "Installation repository catalog cache does not match SCM configuration",
    });
  });

  it.each([
    { name: "a missing entry", entry: () => null },
    {
      name: "an invalid repository",
      entry: (valid: CachedReposList) => ({ ...valid, repos: [{ ...repository, id: "42" }] }),
    },
    {
      name: "a missing SCM identity",
      entry: (valid: CachedReposList) => ({ ...valid, scmIdentity: undefined }),
    },
  ])("fails closed for $name", async ({ entry }) => {
    const env = createEnv();
    cacheStore.get.mockResolvedValue(entry(await cachedCatalog(env)));

    const read = readCachedInstallationRepositories(env);

    await expect(read).rejects.toBeInstanceOf(SourceControlProviderError);
    await expect(read).rejects.toMatchObject({
      errorType: "permanent",
      message: "Installation repository catalog cache is missing or malformed",
    });
  });

  it.each([new SourceControlProviderError("KV timeout", "transient"), "non-Error store failure"])(
    "wraps store read failures as permanent errors (%s)",
    async (cause) => {
      cacheStore.get.mockRejectedValue(cause);

      await expect(readCachedInstallationRepositories(createEnv())).rejects.toMatchObject({
        errorType: "permanent",
        message: "Failed to read installation repository catalog cache",
        cause: cause instanceof Error ? cause : undefined,
      });
    }
  );
});
