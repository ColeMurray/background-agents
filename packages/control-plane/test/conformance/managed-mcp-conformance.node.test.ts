import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { applyMigrations } from "../../src/node/migrate";
import { createNodeSqlDatabase } from "../../src/node/sqlite-database";
import { managedMcpConformance } from "./managed-mcp-conformance";

managedMcpConformance(async (run) => {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON");
  applyMigrations(
    raw,
    fileURLToPath(new URL("../../../../terraform/d1/migrations", import.meta.url).href)
  );
  const db = createNodeSqlDatabase(raw);
  try {
    await run(db);
  } finally {
    db.close();
  }
});
