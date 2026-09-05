/**
 * The `CacheStore` conformance suite on the two implementations the workerd
 * lane can reach: the KV namespace the Cloudflare host binds, and
 * `SqlCacheStore` over D1 — the engine pairing the Node host runs the same
 * adapter against on `node:sqlite`
 * (test/conformance/cache-store-conformance.node.test.ts).
 */

import { env } from "cloudflare:test";
import { describe } from "vitest";
import { createKvCacheStore } from "@open-inspect/shared/cache-store";
import { SqlCacheStore } from "../../src/db/sql-cache-store";
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
  registerCacheStoreConformanceSuite(d1Factory, { controllableClock: true });
});
