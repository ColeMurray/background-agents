/**
 * The session-core conformance suite on `node:sqlite`. The same suite runs on
 * Durable Object storage from test/integration/session-core-conformance.test.ts.
 */

import { DatabaseSync } from "node:sqlite";
import { createNodeSqlStorage } from "./node-sqlite-storage";
import { initSchema } from "../../src/session/schema";
import {
  registerSessionCoreConformanceSuite,
  type SqlStorageFactory,
} from "./session-core-conformance";

const nodeSqliteStorageFactory: SqlStorageFactory = async (run) => {
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

registerSessionCoreConformanceSuite(nodeSqliteStorageFactory);
