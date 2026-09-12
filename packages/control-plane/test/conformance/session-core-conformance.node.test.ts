/**
 * The session-core conformance suite on the Node host's storage, both as an
 * in-memory database and as the per-session file `openSessionStore` manages.
 * The same suite runs on Durable Object storage from
 * test/integration/session-core-conformance.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe } from "vitest";
import { openSessionStore } from "../../src/node/session-store";
import { createNodeSqlStorage } from "../../src/node/sqlite-storage";
import { initSchema } from "../../src/session/schema";
import {
  registerSessionCoreConformanceSuite,
  type SqlStorageFactory,
} from "./session-core-conformance";

const inMemoryStorageFactory: SqlStorageFactory = async (run) => {
  const db = new DatabaseSync(":memory:");
  try {
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    // Await inside the try so the database outlives a callback that resolves later.
    return await run(storage);
  } finally {
    db.close();
  }
};

let fileCount = 0;
const fileStorageFactory: SqlStorageFactory = async (run) => {
  const dataDir = mkdtempSync(join(tmpdir(), "conformance-"));
  const store = openSessionStore({ dataDir, sessionId: `conformance-${(fileCount += 1)}` });
  try {
    return await run(store.storage);
  } finally {
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
};

describe("node:sqlite in memory", () => {
  registerSessionCoreConformanceSuite(inMemoryStorageFactory);
});

describe("node:sqlite session file", () => {
  registerSessionCoreConformanceSuite(fileStorageFactory);
});
