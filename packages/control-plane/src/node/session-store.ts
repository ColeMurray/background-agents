/**
 * One SQLite file per session on a Node host: `<dataDir>/sessions/<id>.db`,
 * opened in WAL mode with a busy timeout and carrying the session schema.
 * This is the Node counterpart of a Durable Object's own storage; the files
 * live on the host's persistent volume, so there is no snapshot cycle.
 */

import { access } from "node:fs/promises";
import { join } from "node:path";
import type { SessionStorage } from "../session/platform";
import { initSchema } from "../session/schema";
import { ensurePrivateDirectory } from "./private-paths";
import { openPrivateSqliteFile } from "./sqlite-file";
import { createNodeSqlStorage } from "./sqlite-storage";

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

/** A session's store, owned by whoever opened it until they close it. */
export type OwnedSessionStore = Pick<NodeSessionStore, "storage" | "close">;

/**
 * How a host acquires a session's store. Acquisition is the host boundary
 * (a file on this host today), so it is asynchronous; the store's query
 * surface behind it stays synchronous.
 */
export interface SessionStoreProvider {
  open(sessionId: string): Promise<OwnedSessionStore>;
  /** Whether the session already has a store, without creating one. */
  exists(sessionId: string): Promise<boolean>;
}

/** The provider over `<dataDir>/sessions/<id>.db` files. */
export function createFileSessionStoreProvider(dataDir: string): SessionStoreProvider {
  return {
    open: async (sessionId) => openSessionStore({ dataDir, sessionId }),
    exists: (sessionId) =>
      SESSION_FILE_ID.test(sessionId)
        ? fileExists(join(dataDir, "sessions", `${sessionId}.db`))
        : Promise.resolve(false),
  };
}

/** Whether `path` exists, asked without blocking the event loop. */
async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Open (creating if needed) the session's database and apply the schema. */
export function openSessionStore(options: OpenSessionStoreOptions): NodeSessionStore {
  const { dataDir, sessionId } = options;
  if (!SESSION_FILE_ID.test(sessionId)) {
    throw new Error(`Session id ${JSON.stringify(sessionId)} cannot name a session file`);
  }
  const directory = join(dataDir, "sessions");
  ensurePrivateDirectory(directory);
  const path = join(directory, `${sessionId}.db`);
  const db = openPrivateSqliteFile(path);
  try {
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    return { storage, path, close: () => db.close() };
  } catch (error) {
    db.close();
    throw error;
  }
}
