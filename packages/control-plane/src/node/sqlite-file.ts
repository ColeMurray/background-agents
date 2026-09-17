/**
 * How the Node host opens a SQLite file it owns: private to the host user,
 * in WAL mode, with a busy timeout so concurrent connections wait for a
 * writer instead of failing. Shared by the per-session stores and the
 * global store.
 */

import { DatabaseSync } from "node:sqlite";
import { makeFilePrivate } from "./private-paths";

/** How long a writer waits on another connection's lock before failing. */
export const BUSY_TIMEOUT_MS = 5_000;

/** How often the WAL switch is retried while another connection holds the file. */
const BUSY_RETRY_MS = 10;
const SQLITE_BUSY = 5;

/**
 * Open (creating if needed) `path` as a private WAL-mode database with the
 * busy timeout set. The directory must already exist. Closes the connection
 * and rethrows if any step fails.
 */
export function openPrivateSqliteFile(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  try {
    // SQLite gives the -wal and -shm files the main file's mode.
    makeFilePrivate(path);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWriteAheadLog(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/**
 * Switch the file to WAL mode, waiting out another connection's write lock.
 * The busy timeout does not cover this switch: SQLite reports SQLITE_BUSY
 * from it at once rather than invoking the busy handler, so a connection
 * opening the same new file while another still holds it would fail. The
 * mode persists in the file, so later opens find it already set.
 */
function enableWriteAheadLog(db: DatabaseSync): void {
  const deadline = Date.now() + BUSY_TIMEOUT_MS;
  for (;;) {
    try {
      db.exec("PRAGMA journal_mode = WAL");
      return;
    } catch (error) {
      if (!isBusy(error) || Date.now() >= deadline) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, BUSY_RETRY_MS);
    }
  }
}

function isBusy(error: unknown): boolean {
  return (error as { errcode?: number }).errcode === SQLITE_BUSY;
}
