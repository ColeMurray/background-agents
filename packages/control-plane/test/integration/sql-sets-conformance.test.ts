import { env } from "cloudflare:test";
import { describe } from "vitest";
import { createD1SqlDatabase } from "../../src/cloudflare/sql-database";
import {
  createRequestMetrics,
  instrumentSqlDatabase,
} from "../../src/db/instrumented-sql-database";
import { registerSqlSetsConformanceSuite } from "../conformance/sql-sets-conformance";

for (const instrumented of [false, true]) {
  describe(`D1 sets (instrumented=${instrumented})`, () => {
    registerSqlSetsConformanceSuite(async (run) => {
      const db = createD1SqlDatabase(env.DB);
      return run(instrumented ? instrumentSqlDatabase(db, createRequestMetrics()) : db);
    });
  });
}
