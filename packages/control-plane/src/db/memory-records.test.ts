import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memorySearchTerms } from "@open-inspect/shared/types/memories";
import { seedSearchFacts } from "../../test/conformance/memory-search-fixtures";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { MemoryRecordStore } from "./memory-records";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase } from "./sql-database";

describe("memory management pagination", () => {
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

  it("merges only IDs and timestamps for deep offsets, then loads bounded final-page bodies", async () => {
    const terms = "one two three four five six seven eight";
    const partitions = Array.from({ length: 60 }, (_, index) => ({
      type: "repository" as const,
      repoId: index + 1,
    }));
    const facts = Array.from({ length: 240 }, (_, index) => ({
      id: `fact-${String(index).padStart(3, "0")}`,
      partition: partitions[index % partitions.length],
      content: `${terms} ${"x".repeat(19000)}`,
      updatedAt: index % 5,
    }));
    await seedSearchFacts(db, "owner", facts);
    const calls: { query: string; values: unknown[]; columns: string[]; count: number }[] = [];
    const measured: SqlDatabase = {
      prepare(query) {
        const statement = db.prepare(query);
        return {
          ...statement,
          bind(...values) {
            const call = { query, values, columns: [] as string[], count: 0 };
            calls.push(call);
            const bound = statement.bind(...values);
            return {
              ...bound,
              async all<T>() {
                const result = await bound.all<T>();
                call.columns = Object.keys((result.results[0] ?? {}) as object);
                call.count = result.results.length;
                return result;
              },
            };
          },
        };
      },
      batch: (statements) => db.batch(statements),
    };
    const result = await new MemoryRecordStore(measured).listPartitions(partitions, {
      status: "active",
      offset: 120,
      limit: 101,
      terms: memorySearchTerms(terms),
    });
    const expected = [...facts]
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      .slice(120, 221);
    expect(result.map((record) => record.id)).toEqual(expected.map((record) => record.id));
    expect(result.every((record) => record.content === facts[0].content)).toBe(true);
    const candidates = calls.filter((call) => call.query.startsWith("SELECT m.id, m.updated_at"));
    const bodies = calls.filter((call) => call.query.startsWith("SELECT m.*, r.title"));
    expect(candidates).toHaveLength(2);
    for (const call of candidates) expect(call.columns).toEqual(["id", "updated_at"]);
    expect(bodies).toHaveLength(2);
    expect(bodies.reduce((total, call) => total + call.count, 0)).toBe(101);
    for (const call of calls)
      expect(call.values.length).toBeLessThanOrEqual(MAX_D1_QUERY_PARAMETERS);
  });
});
