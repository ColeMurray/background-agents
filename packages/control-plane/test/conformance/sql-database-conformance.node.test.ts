/**
 * The `SqlDatabase` conformance suite on the Node host's global store, both
 * in memory and as the WAL-mode file `openNodeSqlDatabase` manages. The same
 * suite runs on D1 from test/integration/sql-database-conformance.test.ts.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe } from "vitest";
import { createNodeSqlDatabase, openNodeSqlDatabase } from "../../src/node/sqlite-database";
import {
  registerSqlDatabaseConformanceSuite,
  type SqlDatabaseFactory,
} from "./sql-database-conformance";

const inMemoryFactory: SqlDatabaseFactory = async (run) => {
  const db = createNodeSqlDatabase(new DatabaseSync(":memory:"));
  try {
    return await run(db);
  } finally {
    db.close();
  }
};

const fileFactory: SqlDatabaseFactory = async (run) => {
  const dataDir = mkdtempSync(join(tmpdir(), "sql-conformance-"));
  const db = openNodeSqlDatabase(join(dataDir, "global.db"));
  try {
    return await run(db);
  } finally {
    db.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
};

describe("node:sqlite in memory", () => {
  registerSqlDatabaseConformanceSuite(inMemoryFactory);
});

describe("node:sqlite global store file", () => {
  registerSqlDatabaseConformanceSuite(fileFactory);
});
