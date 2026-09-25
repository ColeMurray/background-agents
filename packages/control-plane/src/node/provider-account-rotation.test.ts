import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, afterEach } from "vitest";
import { openNodeSqlDatabase, type NodeSqlDatabase } from "./sqlite-database";
import { rotationStorageContract } from "../../test/provider-account-rotation-contract";
let db: NodeSqlDatabase;
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "provider-rotation-"));
  db = openNodeSqlDatabase(join(directory, "test.db"), {
    migrationsDir: resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../../../../terraform/d1/migrations"
    ),
  });
});
afterEach(() => {
  db.close();
  rmSync(directory, { recursive: true, force: true });
});
rotationStorageContract(() => db);
