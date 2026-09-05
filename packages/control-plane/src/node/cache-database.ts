/**
 * The Node host's cache file: `cache.db` beside the global store, holding the
 * one table `SqlCacheStore` uses.
 *
 * It is deliberately not part of the global store. That file's schema is
 * `terraform/d1/migrations`, which is applied to D1 as well, and nothing on
 * Cloudflare caches in SQL — so putting the table there would create it on a
 * host that never touches it. This is the same arrangement as the host alarm
 * index: a Node-local file whose schema is a `CREATE TABLE IF NOT EXISTS` in
 * code, applied on open.
 *
 * Litestream does not replicate it, which is the point: a cache is rebuilt by
 * being used, and the entries include a live GitHub installation token that
 * has no business in a backup bucket. The file survives a restart, which is
 * the whole reason it is a file.
 */

import { join } from "node:path";
import { CACHE_ENTRIES_SCHEMA_SQL } from "../db/sql-cache-store";
import { ensurePrivateDirectory } from "./private-paths";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "./sqlite-database";
import { openPrivateSqliteFile } from "./sqlite-file";

export const CACHE_STORE_FILE = "cache.db";

/** Open (creating if needed) the host's cache database. */
export function openNodeCacheDatabase(dataDir: string): NodeSqlDatabase {
  ensurePrivateDirectory(dataDir);
  const db = openPrivateSqliteFile(join(dataDir, CACHE_STORE_FILE));
  try {
    db.exec(CACHE_ENTRIES_SCHEMA_SQL);
  } catch (error) {
    db.close();
    throw error;
  }
  return createNodeSqlDatabase(db);
}
