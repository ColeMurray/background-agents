export interface CacheStorePutOptions {
  expirationTtl?: number;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

interface KvCacheNamespace {
  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createKvCacheStore(kv: KvCacheNamespace): CacheStore {
  return {
    get: ((key: string, type?: "json") =>
      type === "json" ? kv.get(key, "json") : kv.get(key)) as CacheStore["get"],
    put: (key, value, opts) => (opts ? kv.put(key, value, opts) : kv.put(key, value)),
    delete: (key) => kv.delete(key),
  };
}
