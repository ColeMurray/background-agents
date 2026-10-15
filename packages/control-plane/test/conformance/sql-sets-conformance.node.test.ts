import { DatabaseSync } from "node:sqlite";
import { describe } from "vitest";
import { createNodeSqlDatabase } from "../../src/node/sqlite-database";
import {
  createRequestMetrics,
  instrumentSqlDatabase,
} from "../../src/db/instrumented-sql-database";
import { registerSqlSetsConformanceSuite } from "./sql-sets-conformance";

for (const instrumented of [false, true]) {
  describe(`node:sqlite sets (instrumented=${instrumented})`, () => {
    registerSqlSetsConformanceSuite(async (run) => {
      const engine = createNodeSqlDatabase(new DatabaseSync(":memory:"));
      try {
        return await run(
          instrumented ? instrumentSqlDatabase(engine, createRequestMetrics()) : engine
        );
      } finally {
        engine.close();
      }
    });
  });
}
