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
 *
 * Because every entry is rebuildable, the file is disposable: a corrupt or
 * unreadable one is discarded and recreated rather than failing the boot. The
 * global store gets the opposite treatment for the opposite reason.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";
import { CACHE_ENTRIES_SCHEMA_SQL } from "../db/sql-cache-store";
import type { Logger } from "../logger";
import { ensurePrivateDirectory } from "./private-paths";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "./sqlite-database";
import { openPrivateSqliteFile } from "./sqlite-file";

export const CACHE_STORE_FILE = "cache.db";

function open(path: string): NodeSqlDatabase {
  const db = openPrivateSqliteFile(path);
  try {
    db.exec(CACHE_ENTRIES_SCHEMA_SQL);
  } catch (error) {
    db.close();
    throw error;
  }
  return createNodeSqlDatabase(db);
}

/**
 * Open (creating if needed) the host's cache database, discarding a file that
 * cannot be opened or does not carry the expected table. A second failure is
 * the caller's to handle: at that point the data directory itself is suspect.
 */
export function openNodeCacheDatabase(dataDir: string, log?: Logger): NodeSqlDatabase {
  ensurePrivateDirectory(dataDir);
  const path = join(dataDir, CACHE_STORE_FILE);
  try {
    return open(path);
  } catch (error) {
    log?.warn("Discarding an unusable cache database", {
      event: "node_host.cache_database_discarded",
      path,
      error: error instanceof Error ? error : String(error),
    });
    // The sidecar files go too: a WAL left behind would be replayed into the
    // new database and could carry the same corruption back in.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
    return open(path);
  }
}
