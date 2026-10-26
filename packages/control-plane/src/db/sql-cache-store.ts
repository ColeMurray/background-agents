/**
 * `CacheStore` over a SQL table, for hosts that have no KV.
 *
 * The port has one other implementation, `createKvCacheStore`, which the
 * Cloudflare host keeps. This one is engine-neutral — it runs on any
 * `SqlDatabase`, D1 and `node:sqlite` alike — so it lives with the stores
 * rather than under `src/node/`, and the same adapter serves the bots' caches
 * when they move off KV.
 *
 * The table is not part of the global store's schema. Nothing on Cloudflare
 * reads or writes it, so it is not in `terraform/d1/migrations`, where every
 * table lands on D1 as well; the Node host keeps it in a file of its own
 * (`src/node/cache-database.ts`), the way the host alarm index does. A caller
 * that needs this table on D1 adds the migration then.
 *
 * Expiry is by comparison on read, and reads do not write. Each put reclaims
 * expired rows, including keys that are never read again, so per-repository
 * cache entries do not accumulate as repositories come and go. Idle caches
 * retain expired rows until the next write, but cannot grow while idle.
 *
 * The installation token is stored as written, exactly as it is in KV on
 * Cloudflare. On a container that means the host's own `cache.db`, which
 * Litestream does not replicate — so it stays on the data volume, and a
 * volume snapshot is the one artifact that carries it.
 */

import {
  assertValidCacheTtlMs,
  type CacheStore,
  type CacheStorePutOptions,
} from "@open-inspect/shared/cache-store";
import type { SqlDatabase } from "./sql-database";

/**
 * The table this store reads and writes, as one statement so any engine can
 * apply it. Values are opaque strings; `expires_at` is epoch milliseconds,
 * NULL for an entry that never expires. Reads go by primary key; expiry cleanup
 * uses the companion index.
 */
export const CACHE_ENTRIES_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS cache_entries (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
)`;

export const CACHE_ENTRIES_EXPIRY_INDEX_SQL = `CREATE INDEX IF NOT EXISTS cache_entries_expires_at_idx
  ON cache_entries (expires_at)`;

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
  get(key: string, type: "json"): Promise<unknown | null>;
  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const row = await this.db
      .prepare("SELECT value, expires_at FROM cache_entries WHERE key = ?")
      .bind(key)
      .first<CacheEntryRow>();
    if (!row) return null;
    // Deliberately no delete here. Cleaning up on read would put a write in
    // the read path and race the refresh this miss is about to trigger.
    if (row.expires_at !== null && row.expires_at <= this.now()) return null;
    return type === "json" ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string, opts?: CacheStorePutOptions): Promise<void> {
    const ttlMs = opts?.ttlMs;
    if (ttlMs !== undefined) assertValidCacheTtlMs(ttlMs);
    const now = this.now();
    const expiresAt = ttlMs === undefined ? null : now + ttlMs;
    await this.db.batch([
      this.db.prepare("DELETE FROM cache_entries WHERE expires_at <= ?").bind(now),
      this.db
        .prepare(
          `INSERT INTO cache_entries (key, value, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
        )
        .bind(key, value, expiresAt),
    ]);
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM cache_entries WHERE key = ?").bind(key).run();
  }
}
