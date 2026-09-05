/**
 * `CacheStore` over a table in the global store, for hosts that have no KV.
 *
 * The port has one other implementation, `createKvCacheStore`, which the
 * Cloudflare host keeps. This one is engine-neutral — it runs on any
 * `SqlDatabase`, D1 and `node:sqlite` alike — so it lives with the stores
 * rather than under `src/node/`, and the same adapter serves the bots' caches
 * when they move off KV.
 *
 * Expiry is lazy on read, the way KV's is observable: a row past its TTL
 * reads as absent and is deleted on the spot. `sweepExpired` reclaims the
 * rows nothing reads again; the scheduled `cache_entry_sweep` job calls it.
 *
 * What lands in the table is whatever callers cache, today the repositories
 * listing and GitHub installation tokens. Those tokens are short-lived and
 * stored as written, exactly as they are in KV on Cloudflare — but on a
 * container that means they are in the global store file, and in whatever
 * Litestream replicates it to.
 */

import type { CacheStore, CacheStorePutOptions } from "@open-inspect/shared/cache-store";
import type { SqlDatabase } from "./sql-database";

/**
 * Hourly, at a minute no other scheduled job uses. Expiry is lazy on read, so
 * the sweep only reclaims rows nothing comes back for; an hour of those is a
 * few kilobytes.
 */
export const CACHE_ENTRY_SWEEP_CRON = "41 * * * *";

interface CacheEntryRow {
  value: string;
  /** Epoch ms after which the entry reads as absent; `null` never expires. */
  expires_at: number | null;
}

export interface SqlCacheStoreOptions {
  /** Epoch milliseconds; injected so expiry is testable without waiting. */
  now?: () => number;
}

export class SqlCacheStore implements CacheStore {
  private readonly now: () => number;

  constructor(
    private readonly db: SqlDatabase,
    options: SqlCacheStoreOptions = {}
  ) {
    this.now = options.now ?? (() => Date.now());
  }

  get(key: string): Promise<string | null>;
  get<T>(key: string, type: "json"): Promise<T | null>;
  async get<T>(key: string, type?: "json"): Promise<string | T | null> {
    const row = await this.db
      .prepare("SELECT value, expires_at FROM cache_entries WHERE key = ?")
      .bind(key)
      .first<CacheEntryRow>();
    if (!row) return null;
    if (row.expires_at !== null && row.expires_at <= this.now()) {
      await this.delete(key);
      return null;
    }
    return type === "json" ? (JSON.parse(row.value) as T) : row.value;
  }

  async put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void> {
    const ttlSeconds = opts?.expirationTtl;
    const expiresAt = ttlSeconds === undefined ? null : this.now() + ttlSeconds * 1000;
    await this.db
      .prepare(
        `INSERT INTO cache_entries (key, value, expires_at) VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
      )
      .bind(key, value, expiresAt)
      .run();
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM cache_entries WHERE key = ?").bind(key).run();
  }

  /** Delete every entry whose TTL has passed, and report how many went. */
  async sweepExpired(): Promise<number> {
    const result = await this.db
      .prepare("DELETE FROM cache_entries WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .bind(this.now())
      .run();
    return result.meta.changes;
  }
}
