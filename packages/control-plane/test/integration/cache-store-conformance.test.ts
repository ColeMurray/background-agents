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
import { afterAll, beforeAll, describe } from "vitest";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { CACHE_ENTRIES_SCHEMA_SQL, SqlCacheStore } from "../../src/db/sql-cache-store";
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
  });
  afterAll(async () => {
    await env.DB.prepare("DROP TABLE IF EXISTS cache_entries").run();
  });

  registerCacheStoreConformanceSuite(d1Factory, { controllableClock: true });
});
