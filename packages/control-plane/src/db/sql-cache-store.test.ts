/**
 * What the `CacheStore` contract cannot see: that a row past its TTL is
 * removed rather than hidden — nothing sweeps the table, so a read that
 * leaves the row behind would leak it — and that a key holds one row however
 * often it is written. The port's own semantics are covered for every
 * implementation by the conformance suite
 * (test/conformance/cache-store-conformance.ts).
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { CACHE_ENTRIES_SCHEMA_SQL, SqlCacheStore } from "./sql-cache-store";

let sqlite: DatabaseSync;
let db: NodeSqlDatabase;
let nowMs: number;

const store = (): SqlCacheStore => new SqlCacheStore(db, { now: () => nowMs });

async function rowCount(): Promise<number> {
  const row = await db.prepare("SELECT count(*) AS n FROM cache_entries").first<{ n: number }>();
  return row!.n;
}

beforeEach(() => {
  sqlite = new DatabaseSync(":memory:");
  sqlite.exec(CACHE_ENTRIES_SCHEMA_SQL);
  db = createNodeSqlDatabase(sqlite);
  nowMs = 1_800_000_000_000;
});

afterEach(() => {
  db.close();
});

describe("SqlCacheStore", () => {
  it("deletes an expired row on the read that finds it, rather than leaving it to the sweep", async () => {
    const cache = store();
    await cache.put("k", "v", { expirationTtl: 60 });

    nowMs += 61_000;

    expect(await cache.get("k")).toBeNull();
    expect(await rowCount()).toBe(0);
  });

  it("keeps one row per key however many times it is written", async () => {
    const cache = store();
    await cache.put("k", "first", { expirationTtl: 60 });
    await cache.put("k", "second", { expirationTtl: 120 });

    expect(await rowCount()).toBe(1);
    nowMs += 61_000;
    // The second write replaced the first entry's TTL, not just its value.
    expect(await cache.get("k")).toBe("second");
  });

  it("treats an entry exactly at its expiry as gone", async () => {
    const cache = store();
    await cache.put("k", "v", { expirationTtl: 60 });

    nowMs += 60_000;

    expect(await cache.get("k")).toBeNull();
  });
});
