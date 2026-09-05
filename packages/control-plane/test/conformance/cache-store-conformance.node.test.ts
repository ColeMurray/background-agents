/**
 * The `CacheStore` conformance suite on `SqlCacheStore` over the Node host's
 * global store, built from the same `terraform/d1/migrations` the deploy
 * applies — so the suite also proves the `cache_entries` migration runs on
 * `node:sqlite`. The same suite runs on KV and on D1 from
 * test/integration/cache-store-conformance.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SqlCacheStore } from "../../src/db/sql-cache-store";
import { openNodeSqlDatabase } from "../../src/node/sqlite-database";
import {
  registerCacheStoreConformanceSuite,
  type CacheStoreFactory,
} from "./cache-store-conformance";

const MIGRATIONS_DIR = resolve(__dirname, "../../../../terraform/d1/migrations");

const sqliteFactory: CacheStoreFactory = async (run) => {
  const dataDir = mkdtempSync(join(tmpdir(), "cache-store-conformance-"));
  const db = openNodeSqlDatabase(join(dataDir, "global.db"), { migrationsDir: MIGRATIONS_DIR });
  // The clock is the store's own, so expiry is asserted without waiting.
  let offsetMs = 0;
  try {
    return await run({
      store: new SqlCacheStore(db, { now: () => Date.now() + offsetMs }),
      advance: (ms) => {
        offsetMs += ms;
      },
    });
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
};

registerCacheStoreConformanceSuite(sqliteFactory, { controllableClock: true });
