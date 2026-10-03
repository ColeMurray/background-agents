import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_SEARCH_LIMITS, memorySearchSchema } from "@open-inspect/shared/types/memories";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { applyMigrations } from "../node/migrate";
import { seedSearchFacts } from "../../test/conformance/memory-search-fixtures";
import { searchMemories, type SearchPartition } from "./memory-search";
import type { SqlDatabase } from "./sql-database";

const OWNER = "owner";
const personal: SearchPartition = { partition: { type: "personal", userId: OWNER } };
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

describe("portable memory search", () => {
  it("uses real Node SQLite, preserves ranking across scopes and respects result limits", async () => {
    const environment: SearchPartition = {
      partition: { type: "environment", environmentId: "dev" },
    };
    await seedSearchFacts(db, OWNER, [
      { id: "personal-body", content: "needle", updatedAt: 100 },
      { id: "environment-title", title: "needle", partition: environment.partition },
      { id: "personal-title", title: "needle" },
      { id: "other-owner", title: "needle", partition: { type: "personal", userId: "other" } },
    ]);
    expect(
      await searchMemories(db, memorySearchSchema.parse({ query: "needle", limit: 2 }), [
        personal,
        environment,
      ])
    ).toMatchObject({
      results: [{ id: "environment-title" }, { id: "personal-title" }],
      hasMore: true,
    });
  });
  it("bounds serialized summaries including escaping, without returning matched bodies", async () => {
    await seedSearchFacts(
      db,
      OWNER,
      Array.from({ length: 20 }, (_, i) => ({
        id: `escape-${i}`,
        title: "\u0001".repeat(200),
        description: "\u0001".repeat(420),
        content: "needle PRIVATE_BODY",
      }))
    );
    const result = await searchMemories(
      db,
      memorySearchSchema.parse({ query: "needle", limit: 20 }),
      [personal]
    );
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThan(20);
    expect(result.hasMore).toBe(true);
    expect(JSON.stringify(result).length).toBeLessThanOrEqual(MEMORY_SEARCH_LIMITS.response);
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
  });
});

// Opt-in measurements, not flaky wall-clock assertions in CI. Both deployed engines use this SQL.
describe.skipIf(!process.env.MEMORY_SEARCH_BENCHMARK)("memory search corpus measurements", () => {
  it("records query plans and rare/broad-query timings for representative and maximum fact bodies", async () => {
    const measurements: object[] = [];
    for (const [count, bodySize] of [
      [1000, 2000],
      [10000, 2000],
      [1000, 20000],
      [10000, 20000],
    ]) {
      await db.prepare("DELETE FROM memory_revisions").run();
      await db.prepare("DELETE FROM memories").run();
      await seedSearchFacts(
        db,
        OWNER,
        Array.from({ length: count }, (_, i) => ({
          id: `bench-${i}`,
          content: (
            `common ${i === 0 ? "billing webhook deduplication" : "routine"} ` +
            "x".repeat(bodySize)
          ).slice(0, bodySize),
        }))
      );
      const captured: { sql: string; values: unknown[] }[] = [];
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
      for (const query of ["billing webhook deduplication", "common"]) {
        const durations: number[] = [];
        for (let repeat = 0; repeat < 5; repeat++) {
          const start = performance.now();
          const result = await searchMemories(measured, memorySearchSchema.parse({ query }), [
            personal,
          ]);
          durations.push(performance.now() - start);
          expect(result.results.length).toBe(query === "common" ? 10 : 1);
        }
        durations.sort((a, b) => a - b);
        const last = captured.at(-1)!;
        const plan = await db
          .prepare(`EXPLAIN QUERY PLAN ${last.sql}`)
          .bind(...last.values)
          .all<{ detail: string }>();
        const measurement = {
          count,
          bodySize,
          query,
          medianMs: durations[2],
          maxMs: durations[4],
          plan: plan.results.map((row) => row.detail),
        };
        measurements.push(measurement);
        console.log(JSON.stringify(measurement));
      }
    }
    if (process.env.MEMORY_SEARCH_BENCHMARK_OUTPUT)
      writeFileSync(
        process.env.MEMORY_SEARCH_BENCHMARK_OUTPUT,
        JSON.stringify(measurements, null, 2)
      );
  }, 120_000);
});
