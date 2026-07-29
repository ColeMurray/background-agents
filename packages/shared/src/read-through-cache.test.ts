import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CacheStore } from "./cache-store";
import { createReadThroughCache } from "./read-through-cache";

interface Context {
  store: CacheStore;
}

function createStore(): CacheStore {
  return {
    get: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  } as CacheStore;
}

function createCache(
  overrides: Partial<Parameters<typeof createReadThroughCache<string[], Context>>[0]> = {}
) {
  return createReadThroughCache<string[], Context>({
    cacheKey: "resources:cache",
    cacheTtlSeconds: 300,
    localTtlMs: 60_000,
    load: vi.fn().mockResolvedValue(["fresh"]),
    getCacheStore: (context) => context.store,
    deserialize: (cached) => (Array.isArray(cached) ? (cached as string[]) : null),
    fallback: [],
    ...overrides,
  });
}

describe("createReadThroughCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("loads once and serves the value from memory within the local TTL", async () => {
    const store = createStore();
    const load = vi.fn().mockResolvedValue(["fresh"]);
    const cache = createCache({ load });

    await expect(cache.get({ store }, "trace-1")).resolves.toEqual(["fresh"]);
    vi.advanceTimersByTime(59_999);
    await expect(cache.get({ store }, "trace-2")).resolves.toEqual(["fresh"]);

    expect(load).toHaveBeenCalledOnce();
    expect(store.put).toHaveBeenCalledWith("resources:cache", '["fresh"]', {
      expirationTtl: 300,
    });
  });

  it("reloads after the local TTL expires", async () => {
    const store = createStore();
    const load = vi.fn().mockResolvedValueOnce(["first"]).mockResolvedValueOnce(["second"]);
    const cache = createCache({ load });

    await expect(cache.get({ store })).resolves.toEqual(["first"]);
    vi.advanceTimersByTime(60_000);
    await expect(cache.get({ store })).resolves.toEqual(["second"]);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("uses a valid last-known-good cache value when loading fails", async () => {
    const store = createStore();
    vi.mocked(store.get).mockResolvedValue(["stale"] as never);
    const loadError = new Error("control plane unavailable");
    const onLoadError = vi.fn();
    const cache = createCache({
      load: vi.fn().mockRejectedValue(loadError),
      onLoadError,
    });

    await expect(cache.get({ store }, "trace-1")).resolves.toEqual(["stale"]);

    expect(store.get).toHaveBeenCalledWith("resources:cache", "json");
    expect(onLoadError).toHaveBeenCalledWith(loadError, {
      traceId: "trace-1",
      durationMs: 0,
    });
  });

  it("uses the terminal fallback when the cached value is invalid", async () => {
    const store = createStore();
    vi.mocked(store.get).mockResolvedValue({ invalid: true } as never);
    const cache = createCache({
      load: vi.fn().mockRejectedValue(new Error("load failed")),
      fallback: ["fallback"],
    });

    await expect(cache.get({ store })).resolves.toEqual(["fallback"]);
  });

  it("reports cache read failures and uses the terminal fallback", async () => {
    const store = createStore();
    const cacheError = new Error("KV unavailable");
    vi.mocked(store.get).mockRejectedValue(cacheError);
    const onCacheError = vi.fn();
    const cache = createCache({
      load: vi.fn().mockRejectedValue(new Error("load failed")),
      fallback: ["fallback"],
      onCacheError,
    });

    await expect(cache.get({ store }, "trace-1")).resolves.toEqual(["fallback"]);

    expect(onCacheError).toHaveBeenCalledWith("get", cacheError);
  });

  it("reports cache write failures without discarding the loaded value", async () => {
    const store = createStore();
    const cacheError = new Error("KV unavailable");
    vi.mocked(store.put).mockRejectedValue(cacheError);
    const onCacheError = vi.fn();
    const cache = createCache({ onCacheError });

    await expect(cache.get({ store }, "trace-1")).resolves.toEqual(["fresh"]);

    expect(onCacheError).toHaveBeenCalledWith("put", cacheError, "trace-1");
  });

  it("reloads after invalidation", async () => {
    const store = createStore();
    const load = vi.fn().mockResolvedValueOnce(["first"]).mockResolvedValueOnce(["second"]);
    const cache = createCache({ load });

    await expect(cache.get({ store })).resolves.toEqual(["first"]);
    cache.invalidate();
    await expect(cache.get({ store })).resolves.toEqual(["second"]);

    expect(load).toHaveBeenCalledTimes(2);
  });
});
