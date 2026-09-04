/**
 * The Node host's `CacheStore`: an in-process map with KV's expiry
 * semantics (`expirationTtl` in seconds, read on access). The host is one
 * process, so a process-local cache is the whole cache; a restart starts
 * cold, which for the repos listing costs one upstream fetch per user.
 */

import type { CacheStore, CacheStorePutOptions } from "@open-inspect/shared/cache-store";

/** Entries kept before the oldest is dropped, bounding memory on a long-lived process. */
const DEFAULT_MAX_ENTRIES = 1_000;

interface Entry {
  value: string;
  /** Epoch ms after which the entry reads as absent; `null` never expires. */
  expiresAt: number | null;
}

export interface MemoryCacheStoreOptions {
  maxEntries?: number;
  now?: () => number;
}

export function createMemoryCacheStore(options: MemoryCacheStoreOptions = {}): CacheStore {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? (() => Date.now());
  // Insertion-ordered, so the first key is the oldest put.
  const entries = new Map<string, Entry>();

  const read = (key: string): string | null => {
    const entry = entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= now()) {
      entries.delete(key);
      return null;
    }
    return entry.value;
  };

  return {
    get: (async (key: string, type?: "json") => {
      const value = read(key);
      return value !== null && type === "json" ? JSON.parse(value) : value;
    }) as CacheStore["get"],
    async put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void> {
      // Re-inserted last, so a refreshed key is the newest again.
      entries.delete(key);
      entries.set(key, {
        value,
        expiresAt: opts?.expirationTtl === undefined ? null : now() + opts.expirationTtl * 1000,
      });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    async delete(key: string): Promise<void> {
      entries.delete(key);
    },
  };
}
