/**
 * The `CacheStore` conformance suite on the two implementations the workerd
 * lane can reach: the KV namespace the Cloudflare host binds, and
 * `SqlCacheStore` over D1 — the engine pairing the Node host runs the same
 * adapter against on `node:sqlite`
 * (test/conformance/cache-store-conformance.node.test.ts).
 *
 * Nothing on Cloudflare caches in SQL, so `cache_entries` is not part of the
 * D1 schema and this file creates it from the store's own schema constant.
 * That is the point of running the pairing at all: it is what makes the SQL
 * portable to D1 for whoever needs it there (Q-3), tested rather than assumed.
 */

import { env } from "cloudflare:test";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CACHE_STORE_MIN_TTL_MS, createKvCacheStore } from "@open-inspect/shared/cache-store";
import {
  CACHE_ENTRIES_EXPIRY_INDEX_SQL,
  CACHE_ENTRIES_SCHEMA_SQL,
  SqlCacheStore,
} from "../../src/db/sql-cache-store";
import {
  registerCacheStoreConformanceSuite,
  type CacheStoreFactory,
} from "../conformance/cache-store-conformance";

// Through the same adapter the Cloudflare host builds, not the raw binding.
const kvFactory: CacheStoreFactory = (run) => run({ store: createKvCacheStore(env.REPOS_CACHE) });

const d1Factory: CacheStoreFactory = (run) => {
  let offsetMs = 0;
  return run({
    store: new SqlCacheStore(env.DB, { now: () => Date.now() + offsetMs }),
    advance: (ms) => {
      offsetMs += ms;
    },
  });
};

describe("Cloudflare KV", () => {
  registerCacheStoreConformanceSuite(kvFactory, { controllableClock: false });
});

describe("SqlCacheStore over D1", () => {
  // Pool-workers isolates D1 per test file, so this table is this file's own.
  beforeAll(async () => {
    await env.DB.prepare(CACHE_ENTRIES_SCHEMA_SQL).run();
    await env.DB.prepare(CACHE_ENTRIES_EXPIRY_INDEX_SQL).run();
  });
  afterAll(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS cache_entries").run();
  });

  registerCacheStoreConformanceSuite(d1Factory, { controllableClock: true });

  it("reclaims expired SQL rows when another key is written", async () => {
    let now = Date.now();
    const store = new SqlCacheStore(env.DB, { now: () => now });
    await store.put("expired", "old", { ttlMs: CACHE_STORE_MIN_TTL_MS });
    await store.put("permanent", "retained");
    now += CACHE_STORE_MIN_TTL_MS;

    await store.put("new", "fresh", { ttlMs: CACHE_STORE_MIN_TTL_MS });

    expect(await env.DB.prepare("SELECT key FROM cache_entries ORDER BY key").all()).toMatchObject({
      results: [{ key: "new" }, { key: "permanent" }],
    });
  });

  it("rolls back expiry cleanup when a cache upsert fails", async () => {
    let now = Date.now();
    const store = new SqlCacheStore(env.DB, { now: () => now });
    await store.put("rollback-expired", "old", { ttlMs: CACHE_STORE_MIN_TTL_MS });
    now += CACHE_STORE_MIN_TTL_MS;
    await env.DB.prepare(
      `CREATE TRIGGER reject_cache_insert BEFORE INSERT ON cache_entries
       WHEN NEW.key = 'rollback-rejected'
       BEGIN SELECT RAISE(ABORT, 'forced cache write failure'); END`
    ).run();

    try {
      await expect(store.put("rollback-rejected", "new")).rejects.toThrow(
        "forced cache write failure"
      );
      expect(
        await env.DB.prepare("SELECT value FROM cache_entries WHERE key = ?")
          .bind("rollback-expired")
          .first()
      ).toEqual({ value: "old" });
      expect(await store.get("rollback-rejected")).toBeNull();
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_cache_insert").run();
      await store.delete("rollback-expired");
      await store.delete("rollback-rejected");
    }
  });
});
