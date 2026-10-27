import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listRepositoryBranches } from "../auth/github-app";
import type * as GitHubApp from "../auth/github-app";
import { createTestBackgroundTasks } from "../background-tasks.test-support";
import { createRequestMetrics } from "../db/instrumented-sql-database";
import type { Env } from "../types";
import { createSourceControlProviderFromEnv } from "./provider-from-env";

vi.mock("../auth/github-app", async (importOriginal) => ({
  ...(await importOriginal<typeof GitHubApp>()),
  listRepositoryBranches: vi.fn(),
}));

describe.each(["github", "gitlab"])(
  "%s provider branch caching from environment",
  (providerName) => {
    const branches = [{ name: "main" }];
    const store = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const fetchMock = vi.fn();
    const context = () => ({
      backgroundTasks: createTestBackgroundTasks(),
      metrics: createRequestMetrics(),
    });
    const env = {
      SCM_PROVIDER: providerName,
      GITHUB_APP_ID: "app-1",
      GITHUB_APP_INSTALLATION_ID: "installation-1",
      GITHUB_APP_PRIVATE_KEY: "test-key",
      GITLAB_ACCESS_TOKEN: "test-token",
      GITLAB_NAMESPACE: "acme/platform",
      REPOS_CACHE: store,
    } as unknown as Env;

    beforeEach(() => {
      vi.clearAllMocks();
      store.get.mockResolvedValue(null);
      store.put.mockImplementation(async (_key, value: string) => {
        store.get.mockResolvedValue(JSON.parse(value));
      });
      vi.mocked(listRepositoryBranches).mockResolvedValue(branches);
      fetchMock.mockImplementation(async () => Response.json(branches));
      vi.stubGlobal("fetch", fetchMock);
    });

    afterEach(() => vi.unstubAllGlobals());

    it("caches branch lists across provider instances without involving a route", async () => {
      const repository = { owner: "acme/platform", name: "widgets" };
      const first = await createSourceControlProviderFromEnv(env).listBranches(
        repository,
        context()
      );
      const second = await createSourceControlProviderFromEnv(env).listBranches(
        repository,
        context()
      );

      expect(first).toEqual({ branches, cached: false, cachedAt: expect.any(String) });
      expect(second).toEqual({ ...first, cached: true });
      expect(store.put).toHaveBeenCalledOnce();
      expect(providerName === "github" ? listRepositoryBranches : fetchMock).toHaveBeenCalledOnce();
    });

    it("invalidates cached results when provider credentials change", async () => {
      const repository = { owner: "acme", name: "widgets" };
      await createSourceControlProviderFromEnv(env).listBranches(repository, context());
      const changed = {
        ...env,
        GITHUB_APP_INSTALLATION_ID: "installation-2",
        GITLAB_ACCESS_TOKEN: "rotated-token",
      };
      const result = await createSourceControlProviderFromEnv(changed).listBranches(
        repository,
        context()
      );

      expect(result.cached).toBe(false);
      expect(store.put).toHaveBeenCalledTimes(2);
      expect(providerName === "github" ? listRepositoryBranches : fetchMock).toHaveBeenCalledTimes(
        2
      );
    });
  }
);
