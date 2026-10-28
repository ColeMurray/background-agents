import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { AutomationStore } from "./automation-store";
import type { SqlDatabase } from "./sql-database";

let db: NodeSqlDatabase;

beforeEach(() => {
  const sqlite = new DatabaseSync(":memory:");
  applyMigrations(
    sqlite,
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../../terraform/d1/migrations")
  );
  db = createNodeSqlDatabase(sqlite);
});

afterEach(() => db.close());

describe("AutomationStore query plan", () => {
  it("counts firings by actor kind through the partial actor index", async () => {
    const captured: Array<{ sql: string; values: unknown[] }> = [];
    const measured: SqlDatabase = {
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          ...statement,
          bind(...values) {
            captured.push({ sql, values });
            return statement.bind(...values);
          },
        };
      },
      batch: (statements) => db.batch(statements),
    };

    await new AutomationStore(measured).countFiringsSince("auto-1", {
      actorKind: "bot",
      since: 0,
      limit: 10,
    });

    const [query] = captured;
    const plan = await db
      .prepare(`EXPLAIN QUERY PLAN ${query!.sql}`)
      .bind(...query!.values)
      .all<{ detail: string }>();
    expect(plan.results.map(({ detail }) => detail)).toContainEqual(
      expect.stringContaining("idx_invocations_actor_created")
    );
  });
});
