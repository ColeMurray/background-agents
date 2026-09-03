/**
 * One SQLite file per session on a Node host: `<dataDir>/sessions/<id>.db`,
 * opened in WAL mode with a busy timeout and carrying the session schema.
 * This is the Node counterpart of a Durable Object's own storage; the files
 * live on the host's persistent volume, so there is no snapshot cycle.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SessionStorage } from "../session/platform";
import { initSchema } from "../session/schema";
import { createNodeSqlStorage } from "./sqlite-storage";

/** How long a writer waits on another connection's lock before failing. */
const BUSY_TIMEOUT_MS = 5_000;

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

/** Open (creating if needed) the session's database and apply the schema. */
export function openSessionStore(options: OpenSessionStoreOptions): NodeSessionStore {
  const { dataDir, sessionId } = options;
  if (!SESSION_FILE_ID.test(sessionId)) {
    throw new Error(`Session id ${JSON.stringify(sessionId)} cannot name a session file`);
  }
  const directory = join(dataDir, "sessions");
  mkdirSync(directory, { recursive: true });
  const path = join(directory, `${sessionId}.db`);
  const db = new DatabaseSync(path);
  try {
    db.exec(`PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};`);
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    return { storage, path, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
