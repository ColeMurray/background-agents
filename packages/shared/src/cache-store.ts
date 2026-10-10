export interface CacheStorePutOptions {
  /** Time-to-live in milliseconds. Omit for an entry that never expires. */
  ttlMs?: number;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

interface KvCacheNamespace {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

/**
 * Cloudflare KV's wire option is whole seconds, minimum 60. This adapter is
 * the single place that contract lives: sub-minute TTLs are raised to the
 * minimum rather than sent to KV (which rejects them at runtime), and
 * callers asking for no expiry omit `ttlMs` entirely.
 */
const KV_MIN_TTL_SECONDS = 60;

export function createKvCacheStore(kv: KvCacheNamespace): CacheStore {
  function get(key: string): Promise<string | null>;
  function get(key: string, type: "json"): Promise<unknown | null>;
  function get(key: string, type?: "json"): Promise<string | unknown | null> {
    return type === "json" ? kv.get(key, "json") : kv.get(key);
  }

  return {
    get,
    put: (key, value, opts) =>
      opts?.ttlMs === undefined
        ? kv.put(key, value)
        : kv.put(key, value, {
            expirationTtl: Math.max(KV_MIN_TTL_SECONDS, Math.ceil(opts.ttlMs / 1000)),
          }),
    delete: (key) => kv.delete(key),
  };
}
