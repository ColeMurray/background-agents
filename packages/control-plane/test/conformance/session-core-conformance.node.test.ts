/**
 * The session-core conformance suite on `node:sqlite`. The same suite runs on
 * Durable Object storage from test/integration/session-core-conformance.test.ts.
 */

import { DatabaseSync } from "node:sqlite";
import { createNodeSqlStorage } from "../../src/node/sqlite-storage";
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
    return run(storage);
  } finally {
    db.close();
  }
};

registerSessionCoreConformanceSuite(nodeSqliteStorageFactory);
