export interface CacheStorePutOptions {
  expirationTtl?: number;
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
  put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void>;
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
    put: (key, value, opts) => (opts ? kv.put(key, value, opts) : kv.put(key, value)),
    delete: (key) => kv.delete(key),
  };
}
