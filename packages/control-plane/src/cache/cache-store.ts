export interface CacheStore {
  get<T>(key: string): Promise<T | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createKvCacheStore(kv: KVNamespace): CacheStore {
  return {
    get: <T>(key: string) => kv.get<T>(key, "json"),
    put: (key, value, opts) => kv.put(key, value, opts),
    delete: (key) => kv.delete(key),
  };
}
