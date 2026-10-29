import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CACHE_STORE_MIN_TTL_MS } from "@open-inspect/shared/cache-store";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import {
  CACHE_ENTRIES_EXPIRY_INDEX_SQL,
  CACHE_ENTRIES_SCHEMA_SQL,
  SqlCacheStore,
} from "./sql-cache-store";

describe("SqlCacheStore expiry reclamation", () => {
  let db: NodeSqlDatabase;
  let store: SqlCacheStore;
  let now: number;

  beforeEach(async () => {
    db = createNodeSqlDatabase(new DatabaseSync(":memory:"));
    await db.prepare(CACHE_ENTRIES_SCHEMA_SQL).run();
    await db.prepare(CACHE_ENTRIES_EXPIRY_INDEX_SQL).run();
    now = 0;
    store = new SqlCacheStore(db, { now: () => now });
  });

  afterEach(() => {
    db.close();
  });

  it("reclaims expired keys on write while retaining live and permanent entries", async () => {
    await store.put("expired", "old", { ttlMs: CACHE_STORE_MIN_TTL_MS });
    await store.put("live", "current", { ttlMs: 2 * CACHE_STORE_MIN_TTL_MS });
    await store.put("permanent", "retained");
    now += CACHE_STORE_MIN_TTL_MS;

    await store.put("new", "fresh", { ttlMs: CACHE_STORE_MIN_TTL_MS });

    const rows = await db.prepare("SELECT key FROM cache_entries ORDER BY key").all();
    expect(rows.results).toEqual([{ key: "live" }, { key: "new" }, { key: "permanent" }]);
    expect(await store.get("live")).toBe("current");
    expect(await store.get("permanent")).toBe("retained");
    expect(await store.get("new")).toBe("fresh");
  });

  it("does not write during reads or rejected puts", async () => {
    await store.put("expired", "old", { ttlMs: CACHE_STORE_MIN_TTL_MS });
    now += CACHE_STORE_MIN_TTL_MS;

    expect(await store.get("expired")).toBeNull();
    await expect(store.put("invalid", "value", { ttlMs: 0 })).rejects.toThrow(RangeError);

    expect(await db.prepare("SELECT key FROM cache_entries").all()).toMatchObject({
      results: [{ key: "expired" }],
    });
  });

  it("rolls back expiry cleanup when the upsert fails", async () => {
    await store.put("expired", "old", { ttlMs: CACHE_STORE_MIN_TTL_MS });
    now += CACHE_STORE_MIN_TTL_MS;
    await db
      .prepare(
        `CREATE TRIGGER reject_cache_insert BEFORE INSERT ON cache_entries
         WHEN NEW.key = 'rejected'
         BEGIN SELECT RAISE(ABORT, 'forced cache write failure'); END`
      )
      .run();

    await expect(store.put("rejected", "new")).rejects.toThrow("forced cache write failure");

    expect(await db.prepare("SELECT key, value FROM cache_entries").all()).toMatchObject({
      results: [{ key: "expired", value: "old" }],
    });
    await store.put("accepted", "new");
    expect(await db.prepare("SELECT key, value FROM cache_entries").all()).toMatchObject({
      results: [{ key: "accepted", value: "new" }],
    });
  });
});
