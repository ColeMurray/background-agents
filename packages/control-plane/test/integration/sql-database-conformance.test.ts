/**
 * The `SqlDatabase` conformance suite on the D1 binding, the engine the
 * stores run against on Cloudflare. The same suite runs on the Node host's
 * `node:sqlite` adapter from test/conformance/sql-database-conformance.node.test.ts.
 */

import { env } from "cloudflare:test";
import {
  registerSqlDatabaseConformanceSuite,
  type SqlDatabaseFactory,
} from "../conformance/sql-database-conformance";

const d1Factory: SqlDatabaseFactory = (run) => run(env.DB);

registerSqlDatabaseConformanceSuite(d1Factory);
