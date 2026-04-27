export interface CacheStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: KVNamespacePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

export function createKvCacheStore(kv: KVNamespace): CacheStore {
  return {
    get: (key) => kv.get(key),
    put: (key, value, opts) => (opts ? kv.put(key, value, opts) : kv.put(key, value)),
    delete: (key) => kv.delete(key),
  };
}
