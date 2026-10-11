export interface CacheStorePutOptions {
  /**
   * Time-to-live in milliseconds, at least `CACHE_STORE_MIN_TTL_MS`. Omit for
   * an entry that never expires.
   */
  ttlMs?: number;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * The shortest TTL any `CacheStore` accepts. Cloudflare KV rejects shorter
 * expirations, and every implementation holds callers to the same floor so a
 * TTL that works on one host works on all of them.
 */
export const CACHE_STORE_MIN_TTL_MS = 60_000;

/**
 * Rejects a TTL the port does not accept: non-finite, or under
 * `CACHE_STORE_MIN_TTL_MS`. Every implementation calls this before writing,
 * so a bad TTL fails at the caller on every host instead of being stretched
 * or shortened by one of them.
 */
export function assertValidCacheTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < CACHE_STORE_MIN_TTL_MS) {
    throw new RangeError(
      `CacheStore ttlMs must be a finite number of at least ${CACHE_STORE_MIN_TTL_MS}; got ${ttlMs}`
    );
  }
}

interface KvCacheNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createKvCacheStore(kv: KvCacheNamespace): CacheStore {
  function get(key: string): Promise<string | null>;
  function get(key: string, type: "json"): Promise<unknown | null>;
  function get(key: string, type?: "json"): Promise<string | unknown | null> {
    return type === "json" ? kv.get(key, "json") : kv.get(key);
  }

  return {
    get,
    // Async so an invalid TTL surfaces as a rejected promise, like any other put failure.
    put: async (key, value, opts) => {
      if (opts?.ttlMs === undefined) return kv.put(key, value);
      assertValidCacheTtlMs(opts.ttlMs);
      // KV's wire option is whole seconds; round up so an entry never expires early.
      return kv.put(key, value, { expirationTtl: Math.ceil(opts.ttlMs / 1000) });
    },
    delete: (key) => kv.delete(key),
  };
}
