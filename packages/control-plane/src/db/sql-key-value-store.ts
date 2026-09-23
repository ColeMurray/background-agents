import type { CacheStorePutOptions, KeyValueStore } from "@open-inspect/shared/cache-store";
import type { SqlDatabase } from "./sql-database";

interface EntryRow {
  value: string;
  expires_at: number | null;
}

/** Durable integration state over the replicated global database. */
export class SqlKeyValueStore implements KeyValueStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly now: () => number = Date.now
  ) {}

  get(key: string): Promise<string | null>;
  get(key: string, type: "json"): Promise<unknown | null>;
  async get(key: string, type?: "json"): Promise<string | unknown | null> {
    const row = await this.db
      .prepare("SELECT value, expires_at FROM integration_kv WHERE key = ?")
      .bind(key)
      .first<EntryRow>();
    if (!row || (row.expires_at !== null && row.expires_at <= this.now())) return null;
    return type === "json" ? JSON.parse(row.value) : row.value;
  }

  async put(key: string, value: string, options?: CacheStorePutOptions): Promise<void> {
    const now = this.now();
    const expiresAt =
      options?.expirationTtl === undefined ? null : now + options.expirationTtl * 1000;
    await this.db.batch([
      this.db
        .prepare("DELETE FROM integration_kv WHERE expires_at IS NOT NULL AND expires_at <= ?")
        .bind(now),
      this.db
        .prepare(
          `INSERT INTO integration_kv (key, value, expires_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at`
        )
        .bind(key, value, expiresAt),
    ]);
  }

  async delete(key: string): Promise<void> {
    await this.db.prepare("DELETE FROM integration_kv WHERE key = ?").bind(key).run();
  }

  async list({ prefix }: { prefix: string }): Promise<{ keys: Array<{ name: string }> }> {
    const rows = await this.db
      .prepare(
        `SELECT key FROM integration_kv
         WHERE key >= ? AND key < ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY key`
      )
      .bind(prefix, `${prefix}\uffff`, this.now())
      .all<{ key: string }>();
    return { keys: rows.results.map(({ key }) => ({ name: key })) };
  }
}
