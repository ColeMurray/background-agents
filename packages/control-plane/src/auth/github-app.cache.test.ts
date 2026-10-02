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

/** Config whose key cannot sign, proving a request was served without minting. */
function cacheOnlyConfig(): GitHubAppConfig {
  return { ...config(), privateKey: "invalid-key-must-not-be-used" };
}

function tokenEntry(token: string) {
  return JSON.stringify({
    token,
    cachedAtEpochMs: Date.now(),
    expiresAtEpochMs: Date.now() + 60 * 60 * 1000,
  });
}

function mintResponse(token = "fresh-token") {
  return Response.json({ token, expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString() });
}

describe("installation token scopes", () => {
  it("shares a cache key across permuted or duplicated ids and separates every other scope", async () => {
    const key = (scope: TokenScope, app = config()) =>
      auth.getInstallationTokenCacheKey(app, scope);
    const canonical = await key({ kind: "repositories", repositoryIds: [30, 2, 30] });
    expect(await key({ kind: "repositories", repositoryIds: [2, 30] })).toBe(canonical);

    const others = await Promise.all([
      key({ kind: "repositories", repositoryIds: [2] }),
      key({ kind: "repositories", repositoryIds: [2, 30, 99] }),
      key({ kind: "all" }),
      key({ kind: "repositories", repositoryIds: [2, 30] }, { ...config(), appId: "other-app" }),
      key(
        { kind: "repositories", repositoryIds: [2, 30] },
        { ...config(), installationId: "other-installation" }
      ),
    ]);
    expect(new Set([canonical, ...others]).size).toBe(others.length + 1);
  });

  it("mints repository scopes with their canonical ids and installation scopes without a body", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mintResponse());
    await auth.getCachedInstallationToken(config(), undefined, {
      scope: { kind: "repositories", repositoryIds: [30, 2, 30] },
    });
    await auth.getCachedInstallationToken(config(), undefined, { scope: { kind: "all" } });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [[, scoped], [, all]] = fetchMock.mock.calls;
    expect(new Headers(scoped?.headers).get("Content-Type")).toBe("application/json");
    expect(JSON.parse(String(scoped?.body))).toEqual({ repository_ids: [2, 30] });
    expect(all?.body).toBeUndefined();
  });

  it("refuses an empty repository scope before reading the cache or minting", async () => {
    const cacheStore = new FakeCacheStore();
    const get = vi.spyOn(cacheStore, "get");
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      auth.getCachedInstallationToken(
        config(),
        { cacheStore },
        { scope: { kind: "repositories", repositoryIds: [] } }
      )
    ).rejects.toThrow("no repositories");
    expect(get).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("installation token memory cache", () => {
  it("evicts the least recently used scope at the memory bound", async () => {
    const cacheStore = new FakeCacheStore();
    const app = cacheOnlyConfig();
    const scope = (id: number): TokenScope => ({ kind: "repositories", repositoryIds: [id] });
    const read = (id: number) =>
      auth.getCachedInstallationToken(app, { cacheStore }, { scope: scope(id) });
    const max = auth.INSTALLATION_TOKEN_MEMORY_CACHE_MAX_ENTRIES;
    for (let id = 1; id <= max + 1; id++) {
      await cacheStore.put(
        await auth.getInstallationTokenCacheKey(app, scope(id)),
        tokenEntry(`token-${id}`)
      );
      await read(id);
      // Touch the first scope so the second becomes least recently used.
      if (id === max) await read(1);
    }
    for (const id of [1, 2]) {
      await cacheStore.put(
        await auth.getInstallationTokenCacheKey(app, scope(id)),
        tokenEntry("replaced")
      );
    }

    expect(await read(1)).toBe("token-1");
    expect(await read(2)).toBe("replaced");
  });

  it("serves memory hits until the cache max age, then rereads the persistent cache", async () => {
    const cacheStore = new FakeCacheStore();
    const app = cacheOnlyConfig();
    const scope: TokenScope = { kind: "all" };
    const key = await auth.getInstallationTokenCacheKey(app, scope);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await cacheStore.put(key, tokenEntry("old-token"));
    expect(await auth.getCachedInstallationToken(app, { cacheStore }, { scope })).toBe("old-token");
    await cacheStore.put(key, tokenEntry("new-token"));
    expect(await auth.getCachedInstallationToken(app, { cacheStore }, { scope })).toBe("old-token");
    now += auth.INSTALLATION_TOKEN_CACHE_MAX_AGE_MS;
    await cacheStore.put(key, tokenEntry("new-token"));
    expect(await auth.getCachedInstallationToken(app, { cacheStore }, { scope })).toBe("new-token");
  });

  it("drops the memory and persistent entries on invalidation", async () => {
    const cacheStore = new FakeCacheStore();
    const app = cacheOnlyConfig();
    const scope: TokenScope = { kind: "all" };
    const key = await auth.getInstallationTokenCacheKey(app, scope);
    await cacheStore.put(key, tokenEntry("rejected-token"));
    expect(await auth.getCachedInstallationToken(app, { cacheStore }, { scope })).toBe(
      "rejected-token"
    );

    await auth.invalidateInstallationTokenCache({ cacheStore }, key);
    expect(cacheStore.entries.has(key)).toBe(false);
    await cacheStore.put(key, tokenEntry("replacement-token"));
    expect(await auth.getCachedInstallationToken(app, { cacheStore }, { scope })).toBe(
      "replacement-token"
    );
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mintResponse());
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
      return mintResponse();
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
    release.resolve();
    expect(await Promise.all([first, second, third])).toEqual([
      "fresh-token",
      "fresh-token",
      "fresh-token",
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight mint registered when the scope is invalidated", async () => {
    const cacheStore = new FakeCacheStore();
    const started = deferred<void>();
    const release = deferred<void>();
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      started.resolve();
      await release.promise;
      return mintResponse();
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
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => mintResponse());
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
      .mockResolvedValueOnce(mintResponse());
    await expect(
      auth.getCachedInstallationToken(config(), undefined, { scope, forceRefresh: true })
    ).rejects.toThrow("network failure");
    expect(await auth.getCachedInstallationToken(config(), undefined, { scope })).toBe(
      "fresh-token"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
