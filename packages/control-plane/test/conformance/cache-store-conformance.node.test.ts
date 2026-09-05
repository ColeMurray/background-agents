/**
 * The `CacheStore` conformance suite on `SqlCacheStore` over the Node host's
 * cache file, opened exactly as the host opens it. The same suite runs on KV
 * and on D1 from test/integration/cache-store-conformance.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SqlCacheStore } from "../../src/db/sql-cache-store";
import { openNodeCacheDatabase } from "../../src/node/cache-database";
import {
  registerCacheStoreConformanceSuite,
  type CacheStoreFactory,
} from "./cache-store-conformance";

const sqliteFactory: CacheStoreFactory = async (run) => {
  const dataDir = mkdtempSync(join(tmpdir(), "cache-store-conformance-"));
  const db = openNodeCacheDatabase(dataDir);
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
