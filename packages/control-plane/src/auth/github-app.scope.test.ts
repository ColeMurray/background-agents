import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCachedInstallationToken,
  getCachedInstallationTokenWithExpiry,
  getInstallationTokenCacheKey,
  type GitHubAppConfig,
} from "./github-app";
import { SourceControlProviderError } from "../source-control/errors";

const config: GitHubAppConfig = {
  appId: "scope-test-app",
  installationId: "scope-test-installation",
  privateKey: "invalid-key-must-not-be-used",
};

afterEach(() => vi.restoreAllMocks());

describe("installation token scope keys", () => {
  it("uses a fresh v2 key for installation-wide tokens", async () => {
    expect(await getInstallationTokenCacheKey(config, { kind: "all" })).toBe(
      "github:installation-token:v2:scope-test-app:scope-test-installation:all"
    );
  });

  it("hashes the canonical repository id set with SHA-256", async () => {
    const key = await getInstallationTokenCacheKey(config, {
      kind: "repositories",
      repositoryIds: [30, 2, 30],
    });
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("[2,30]"));
    const hash = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    expect(key).toBe(`github:installation-token:v2:scope-test-app:scope-test-installation:${hash}`);
    expect(key).toBe(
      await getInstallationTokenCacheKey(config, {
        kind: "repositories",
        repositoryIds: [2, 30],
      })
    );
  });

  it("changes the key when a repository is added or removed", async () => {
    const keys = await Promise.all(
      [[2], [2, 30], [30]].map((repositoryIds) =>
        getInstallationTokenCacheKey(config, { kind: "repositories", repositoryIds })
      )
    );
    expect(new Set(keys).size).toBe(3);
  });

  it("separates apps and installations even for an identical scope", async () => {
    const scope = { kind: "repositories", repositoryIds: [2] } as const;
    const key = await getInstallationTokenCacheKey(config, { ...scope, repositoryIds: [2] });
    expect(
      await getInstallationTokenCacheKey(
        { ...config, appId: "another-app" },
        {
          ...scope,
          repositoryIds: [2],
        }
      )
    ).not.toBe(key);
    expect(
      await getInstallationTokenCacheKey(
        { ...config, installationId: "another-installation" },
        {
          ...scope,
          repositoryIds: [2],
        }
      )
    ).not.toBe(key);
  });
});

describe("empty and invalid installation token scopes", () => {
  it("refuses 501 unique repository ids before reading cache or minting", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cacheStore = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const scope = {
      kind: "repositories" as const,
      repositoryIds: Array.from({ length: 501 }, (_, i) => i + 1),
    };
    await expect(
      getCachedInstallationToken(config, { cacheStore }, { scope })
    ).rejects.toBeInstanceOf(SourceControlProviderError);
    expect(cacheStore.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses an unmintable scope when deriving its cache key", async () => {
    await expect(
      getInstallationTokenCacheKey(config, {
        kind: "repositories",
        repositoryIds: Array.from({ length: 501 }, (_, i) => i + 1),
      })
    ).rejects.toThrow("500");
  });

  it("refuses an empty scope before reading cache or making a request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const cacheStore = { get: vi.fn(), put: vi.fn(), delete: vi.fn() };
    const scope = { kind: "repositories" as const, repositoryIds: [] };
    await expect(getCachedInstallationToken(config, { cacheStore }, { scope })).rejects.toThrow(
      "no repositories"
    );
    await expect(
      getCachedInstallationTokenWithExpiry(config, { cacheStore }, { scope })
    ).rejects.toThrow("no repositories");
    expect(cacheStore.get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([[-1], [0], [1.5], [NaN], [Number.MAX_SAFE_INTEGER + 1]])(
    "refuses invalid repository ids %j before minting",
    async (...repositoryIds) => {
      const fetchMock = vi.spyOn(globalThis, "fetch");
      await expect(
        getCachedInstallationToken(config, undefined, {
          scope: { kind: "repositories", repositoryIds },
        })
      ).rejects.toThrow("invalid repository ids");
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );
});
