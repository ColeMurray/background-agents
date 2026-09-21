export interface CacheStorePutOptions {
  expirationTtl?: number;
}

export interface CacheStoreListResult {
  keys: Array<{ name: string }>;
}

export interface CacheStore {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void>;
  delete(key: string): Promise<void>;
}

/** A cache that can also enumerate a bounded logical key prefix. */
export interface KeyValueStore extends CacheStore {
  list(options: { prefix: string }): Promise<CacheStoreListResult>;
}

interface KvCacheNamespace extends KeyValueStore {
  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void>;
}

export function createKvCacheStore(kv: KvCacheNamespace): KeyValueStore {
  function get(key: string): Promise<string | null>;
  function get(key: string, type: "json"): Promise<unknown | null>;
  function get(key: string, type?: "json"): Promise<string | unknown | null> {
    return type === "json" ? kv.get(key, "json") : kv.get(key);
  }

  return {
    get,
    put: (key, value, opts) => (opts ? kv.put(key, value, opts) : kv.put(key, value)),
    delete: (key) => kv.delete(key),
    list: (options) => kv.list(options),
  };
}

/** Give one physical store independent logical key spaces. */
export function prefixKeyValueStore(store: KeyValueStore, namespace: string): KeyValueStore {
  const prefix = `${namespace}:`;
  function get(key: string): Promise<string | null>;
  function get(key: string, type: "json"): Promise<unknown | null>;
  function get(key: string, type?: "json"): Promise<string | unknown | null> {
    return type === "json" ? store.get(prefix + key, type) : store.get(prefix + key);
  }
  return {
    get,
    put: (key, value, options) => store.put(prefix + key, value, options),
    delete: (key) => store.delete(prefix + key),
    async list(options) {
      const result = await store.list({ prefix: prefix + options.prefix });
      return { keys: result.keys.map(({ name }) => ({ name: name.slice(prefix.length) })) };
    },
  };
}
