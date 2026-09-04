/**
 * One SQLite file per session on a Node host: `<dataDir>/sessions/<id>.db`,
 * opened in WAL mode with a busy timeout and carrying the session schema.
 * This is the Node counterpart of a Durable Object's own storage; the files
 * live on the host's persistent volume, so there is no snapshot cycle.
 */

import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionStorage } from "../session/platform";
import { initSchema } from "../session/schema";
import { ensurePrivateDirectory, makeFilePrivate } from "./private-paths";
import { createNodeSqlStorage } from "./sqlite-storage";

/** How long a writer waits on another connection's lock before failing. */
const BUSY_TIMEOUT_MS = 5_000;

/** How often the WAL switch is retried while another connection holds the file. */
const BUSY_RETRY_MS = 10;
const SQLITE_BUSY = 5;

/** A session id must be a single path segment: it names the file directly. */
const SESSION_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface OpenSessionStoreOptions {
  /** The host's data directory; the `sessions` subdirectory is created inside it. */
  dataDir: string;
  sessionId: string;
}

export interface NodeSessionStore {
  storage: SessionStorage;
  /** The database file's path. */
  path: string;
  /** Close the connection. Every later statement throws. */
  close(): void;
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

/** Open (creating if needed) the session's database and apply the schema. */
export function openSessionStore(options: OpenSessionStoreOptions): NodeSessionStore {
  const { dataDir, sessionId } = options;
  if (!SESSION_FILE_ID.test(sessionId)) {
    throw new Error(`Session id ${JSON.stringify(sessionId)} cannot name a session file`);
  }
  // SQLite gives the -wal and -shm files the main file's mode.
  const directory = join(dataDir, "sessions");
  ensurePrivateDirectory(directory);
  const path = join(directory, `${sessionId}.db`);
  const db = new DatabaseSync(path);
  try {
    makeFilePrivate(path);
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    enableWriteAheadLog(db);
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    return { storage, path, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
