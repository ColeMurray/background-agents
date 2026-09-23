/**
 * What the `CacheStore` contract cannot see: how many rows are behind it.
 * Reads never write, so an expired row stays until the refresh its miss
 * triggers overwrites the same key, and a key written repeatedly is still one
 * row. The port's own semantics are covered for every implementation by the
 * conformance suite
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
  it("reads an expired row as absent without writing on the read path", async () => {
    const cache = store();
    await cache.put("k", "v", { expirationTtl: 60 });

    nowMs += 61_000;

    expect(await cache.get("k")).toBeNull();
    // Still there: the miss goes to a refresh that overwrites this same key,
    // so cleaning up here would only add a write and a race to the read path.
    expect(await rowCount()).toBe(1);
  });

  it("replaces the expired row when the refresh that the miss triggered writes back", async () => {
    const cache = store();
    await cache.put("k", "stale", { expirationTtl: 60 });

    nowMs += 61_000;
    expect(await cache.get("k")).toBeNull();
    await cache.put("k", "fresh", { expirationTtl: 60 });

    expect(await cache.get("k")).toBe("fresh");
    expect(await rowCount()).toBe(1);
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
