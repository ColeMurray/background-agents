import type { CacheStore } from "@open-inspect/shared/cache-store";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitHubAppConfig, TokenScope } from "./github-app";
import type * as GitHubAppAuth from "./github-app";

class FakeCacheStore implements CacheStore {
  readonly entries = new Map<string, string>();

  async get(key: string): Promise<string | null>;
  async get(key: string, type: "json"): Promise<unknown | null>;
  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const value = this.entries.get(key) ?? null;
    return type === "json" && value !== null ? JSON.parse(value) : value;
  }

  async put(key: string, value: string): Promise<void> {
    this.entries.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.entries.delete(key);
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

let privateKey: string;
let auth: typeof GitHubAppAuth;

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"]
  );
  if (!("privateKey" in pair)) throw new Error("Expected an RSA key pair");
  const exported = await crypto.subtle.exportKey("pkcs8", pair.privateKey);
  if (!(exported instanceof ArrayBuffer)) throw new Error("Expected a PKCS#8 byte buffer");
  privateKey = `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...new Uint8Array(exported)))}\n-----END PRIVATE KEY-----`;
});

beforeEach(async () => {
  vi.resetModules();
  auth = await import("./github-app");
});

afterEach(() => vi.restoreAllMocks());

function config(): GitHubAppConfig {
  return { appId: "cache-test-app", installationId: "cache-test-installation", privateKey };
}

function tokenEntry(token: string) {
  return JSON.stringify({
    token,
    cachedAtEpochMs: Date.now(),
    expiresAtEpochMs: Date.now() + 60 * 60 * 1000,
  });
}

describe("installation token memory cache", () => {
  it("evicts old scopes at the memory bound and reuses their persistent entries", async () => {
    const cacheStore = new FakeCacheStore();
    const app = { ...config(), privateKey: "invalid-key-must-not-be-used" };
    const firstScope: TokenScope = { kind: "repositories", repositoryIds: [1] };
    const firstKey = await auth.getInstallationTokenCacheKey(app, firstScope);
    expect(auth.INSTALLATION_TOKEN_MEMORY_CACHE_MAX_ENTRIES).toBeGreaterThan(0);
    for (let id = 1; id <= auth.INSTALLATION_TOKEN_MEMORY_CACHE_MAX_ENTRIES + 1; id++) {
      const scope: TokenScope = { kind: "repositories", repositoryIds: [id] };
      const key = await auth.getInstallationTokenCacheKey(app, scope);
      await cacheStore.put(key, tokenEntry(`token-${id}`));
      await auth.getCachedInstallationToken(app, { cacheStore }, { scope });
    }
    await cacheStore.put(firstKey, tokenEntry("persisted-replacement"));
    const fetchMock = vi.spyOn(globalThis, "fetch");
    expect(await auth.getCachedInstallationToken(app, { cacheStore }, { scope: firstScope })).toBe(
      "persisted-replacement"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refreshes an unusable memory entry instead of returning token material past its cache age", async () => {
    const cacheStore = new FakeCacheStore();
    const app = { ...config(), privateKey: "invalid-key-must-not-be-used" };
    const scope: TokenScope = { kind: "all" };
    const key = await auth.getInstallationTokenCacheKey(app, scope);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await cacheStore.put(key, tokenEntry("old-token"));
    expect(await auth.getCachedInstallationToken(app, { cacheStore }, { scope })).toBe("old-token");
    now += auth.INSTALLATION_TOKEN_CACHE_MAX_AGE_MS / 2;
    expect(await auth.getCachedInstallationToken(app, { cacheStore }, { scope })).toBe("old-token");
    now += auth.INSTALLATION_TOKEN_CACHE_MAX_AGE_MS / 2;
    await cacheStore.put(key, tokenEntry("new-token"));
    expect(await auth.getCachedInstallationToken(app, { cacheStore }, { scope })).toBe("new-token");
  });
});

describe("installation token refresh single-flight", () => {
  it("starts a fresh mint when a forced caller arrives after a persistent hit was selected", async () => {
    const cacheStore = new FakeCacheStore();
    const app = config();
    const scope: TokenScope = { kind: "all" };
    await cacheStore.put(
      await auth.getInstallationTokenCacheKey(app, scope),
      tokenEntry("cached-token")
    );
    const selected = deferred<void>();
    const releaseCleanup = deferred<void>();
    const originalFinally = Promise.prototype.finally;
    vi.spyOn(Promise.prototype, "finally").mockImplementationOnce(function (
      this: Promise<unknown>,
      cleanup
    ) {
      return originalFinally.call(this, async () => {
        selected.resolve();
        await releaseCleanup.promise;
        cleanup?.();
      });
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        token: "fresh-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    );
    const first = auth.getCachedInstallationToken(app, { cacheStore }, { scope });
    await selected.promise;
    const forced = auth.getCachedInstallationToken(
      app,
      { cacheStore },
      { scope, forceRefresh: true }
    );
    await Promise.resolve();
    releaseCleanup.resolve();
    expect(await first).toBe("cached-token");
    expect(await forced).toBe("fresh-token");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("joins overlapping forced and ordinary refreshes for the same scope", async () => {
    const started = deferred<void>();
    const release = deferred<void>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return Response.json({
        token: "fresh-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    });
    const scope: TokenScope = { kind: "all" };
    const first = auth.getCachedInstallationToken(config(), undefined, {
      scope,
      forceRefresh: true,
    });
    await started.promise;
    const second = auth.getCachedInstallationToken(config(), undefined, {
      scope,
      forceRefresh: true,
    });
    const third = auth.getCachedInstallationToken(config(), undefined, { scope });
    await Promise.resolve();
    release.resolve();
    expect(await Promise.all([first, second, third])).toEqual([
      "fresh-token",
      "fresh-token",
      "fresh-token",
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps active refresh work registered during invalidation", async () => {
    const cacheStore = new FakeCacheStore();
    const started = deferred<void>();
    const release = deferred<void>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return Response.json({
        token: "fresh-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      });
    });
    const app = config();
    const scope: TokenScope = { kind: "all" };
    const first = auth.getCachedInstallationToken(
      app,
      { cacheStore },
      { scope, forceRefresh: true }
    );
    await started.promise;
    await auth.invalidateInstallationTokenCache(
      { cacheStore },
      await auth.getInstallationTokenCacheKey(app, scope)
    );
    const second = auth.getCachedInstallationToken(
      app,
      { cacheStore },
      { scope, forceRefresh: true }
    );
    await Promise.resolve();
    release.resolve();
    expect(await Promise.all([first, second])).toEqual(["fresh-token", "fresh-token"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("discards a pending persistent-cache read invalidated before it completes", async () => {
    const cacheStore = new FakeCacheStore();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    vi.spyOn(cacheStore, "get").mockImplementation(async () => {
      readStarted.resolve();
      await releaseRead.promise;
      return JSON.parse(tokenEntry("rejected-token"));
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        token: "fresh-token",
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      })
    );
    const app = config();
    const scope: TokenScope = { kind: "all" };
    const first = auth.getCachedInstallationToken(app, { cacheStore }, { scope });
    await readStarted.promise;
    await auth.invalidateInstallationTokenCache(
      { cacheStore },
      await auth.getInstallationTokenCacheKey(app, scope)
    );
    const forced = auth.getCachedInstallationToken(
      app,
      { cacheStore },
      { scope, forceRefresh: true }
    );
    releaseRead.resolve();
    expect(await Promise.all([first, forced])).toEqual(["fresh-token", "fresh-token"]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("cleans up a failed flight so a later request can retry", async () => {
    const scope: TokenScope = { kind: "all" };
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValueOnce(new Error("network failure"))
      .mockResolvedValueOnce(
        Response.json({
          token: "fresh-token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        })
      );
    await expect(
      auth.getCachedInstallationToken(config(), undefined, { scope, forceRefresh: true })
    ).rejects.toThrow("network failure");
    expect(await auth.getCachedInstallationToken(config(), undefined, { scope })).toBe(
      "fresh-token"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("mints only once when concurrent provider requests recover from a 401", async () => {
    const { GitHubSourceControlProvider } =
      await import("../source-control/providers/github-provider");
    const cacheStore = new FakeCacheStore();
    const app = config();
    const scope: TokenScope = { kind: "all" };
    await cacheStore.put(
      await auth.getInstallationTokenCacheKey(app, scope),
      tokenEntry("rejected-token")
    );
    const started = deferred<void>();
    const release = deferred<void>();
    let mints = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      if (String(input).endsWith("/access_tokens")) {
        mints++;
        started.resolve();
        await release.promise;
        return Response.json({
          token: "fresh-token",
          expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        });
      }
      if (new Headers(init?.headers).get("Authorization") === "Bearer rejected-token") {
        return new Response("Unauthorized", { status: 401 });
      }
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fresh-token");
      return Response.json({ object: { sha: "branch-head" } });
    });
    const provider = new GitHubSourceControlProvider({ appConfig: app, cacheStore });
    const target = { owner: "acme", name: "web", branch: "main" };
    const first = provider.getBranchHead(target, scope);
    const second = provider.getBranchHead(target, scope);
    await started.promise;
    release.resolve();
    expect(await Promise.all([first, second])).toEqual(["branch-head", "branch-head"]);
    expect(mints).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
});
