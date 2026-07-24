import type { CacheStore } from "./cache-store";

export interface ReadThroughCacheOptions<T, Context> {
  cacheKey: string;
  cacheTtlSeconds: number;
  localTtlMs: number;
  load: (context: Context, traceId?: string) => Promise<T>;
  getCacheStore: (context: Context) => CacheStore;
  deserialize: (cached: unknown) => T | null;
  fallback: T;
  onLoadError?: (error: unknown, details: { traceId?: string; durationMs: number }) => void;
  onCacheError?: (operation: "get" | "put", error: unknown, traceId?: string) => void;
}

export interface ReadThroughCache<T, Context> {
  get(context: Context, traceId?: string): Promise<T>;
  /** Drops only the in-memory value; the persistent fallback remains intact. */
  invalidate(): void;
}

/**
 * Creates a fail-open cache backed by local memory and a persistent
 * last-known-good store. Callers retain control of loading and diagnostics.
 */
export function createReadThroughCache<T, Context>(
  options: ReadThroughCacheOptions<T, Context>
): ReadThroughCache<T, Context> {
  let memory: { value: T; timestamp: number } | null = null;

  async function readCacheFallback(context: Context): Promise<T> {
    try {
      const cached = await options.getCacheStore(context).get<unknown>(options.cacheKey, "json");
      const value = cached === null ? null : options.deserialize(cached);
      if (value !== null) return value;
    } catch (error) {
      options.onCacheError?.("get", error);
    }
    return options.fallback;
  }

  async function get(context: Context, traceId?: string): Promise<T> {
    if (memory && Date.now() - memory.timestamp < options.localTtlMs) {
      return memory.value;
    }

    const startTime = Date.now();
    try {
      const value = await options.load(context, traceId);
      memory = { value, timestamp: Date.now() };

      try {
        await options.getCacheStore(context).put(options.cacheKey, JSON.stringify(value), {
          expirationTtl: options.cacheTtlSeconds,
        });
      } catch (error) {
        options.onCacheError?.("put", error, traceId);
      }

      return value;
    } catch (error) {
      options.onLoadError?.(error, {
        traceId,
        durationMs: Date.now() - startTime,
      });
      return readCacheFallback(context);
    }
  }

  return {
    get,
    invalidate() {
      memory = null;
    },
  };
}
