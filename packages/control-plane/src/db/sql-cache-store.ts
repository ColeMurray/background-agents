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
 * Expiry is by comparison on read, and reads do not write: a row past its TTL
 * reads as absent and is left where it is. Nothing reclaims it and nothing
 * needs to, because the key space is two singletons — the repositories listing
 * and one GitHub installation token — and the miss it causes goes straight to
 * a refresh that overwrites the same key. The most an unlucky deployment holds
 * is those two rows, inert. A caller that starts writing keys nobody reads back
 * (per-user, per-repo) is the one that would need a sweep; there is none today.
 *
 * The installation token is stored as written, exactly as it is in KV on
 * Cloudflare. On a container that means the host's own `cache.db`, which
 * Litestream does not replicate — so it stays on the data volume, and a
 * volume snapshot is the one artifact that carries it.
 */

import type { CacheStore, CacheStorePutOptions } from "@open-inspect/shared/cache-store";
import type { SqlDatabase } from "./sql-database";

/**
 * The table this store reads and writes, as one statement so any engine can
 * apply it. Values are opaque strings; `expires_at` is epoch milliseconds,
 * NULL for an entry that never expires. No index on it: reads go by primary
 * key and expiry is lazy, so nothing queries the column.
 */
export const CACHE_ENTRIES_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS cache_entries (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER
)`;

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
    // Deliberately no delete here. Cleaning up on read would put a write in
    // the read path and race the refresh this miss is about to trigger.
    if (row.expires_at !== null && row.expires_at <= this.now()) return null;
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
}
