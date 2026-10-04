import { DatabaseSync } from "node:sqlite";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { memorySearchTerms } from "@open-inspect/shared/types/memories";
import type { FactQuery, FactSearchPartition } from "../memory/fact-search";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { applyMigrations } from "../node/migrate";
import { seedSearchFacts } from "../../test/conformance/memory-search-fixtures";
import { LexicalFactIndex } from "./lexical-fact-index";
import type { SqlDatabase } from "./sql-database";

const OWNER = "owner";
const personal: FactSearchPartition = { partition: { type: "personal", userId: OWNER } };
const query = (text: string, partitions: FactSearchPartition[], limit = 10): FactQuery => ({
  terms: memorySearchTerms(text),
  partitions,
  limit,
});
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

describe("LexicalFactIndex", () => {
  it("ranks across partitions in one statement and returns at most limit + 1 hits", async () => {
    const environment: FactSearchPartition = {
      partition: { type: "environment", environmentId: "dev" },
    };
    await seedSearchFacts(db, OWNER, [
      { id: "personal-body", content: "needle", updatedAt: 100 },
      { id: "environment-title", title: "needle", partition: environment.partition },
      { id: "personal-title", title: "needle" },
      { id: "other-owner", title: "needle", partition: { type: "personal", userId: "other" } },
    ]);
    const hits = await new LexicalFactIndex(db).search(query("needle", [personal, environment], 2));
    expect(hits.map((hit) => hit.id)).toEqual([
      "environment-title",
      "personal-title",
      "personal-body",
    ]);
    expect(hits[0].partition).toEqual(environment.partition);
  });
  it("requires every term, restricts pinned partitions, and never returns bodies", async () => {
    await seedSearchFacts(db, OWNER, [
      { id: "both", title: "billing", content: "webhook PRIVATE_BODY" },
      { id: "one", title: "billing" },
      { id: "unpinned", title: "billing webhook" },
    ]);
    const index = new LexicalFactIndex(db);
    const hits = await index.search(query("billing webhook", [personal]));
    expect(hits.map((hit) => hit.id)).toEqual(["unpinned", "both"]);
    expect(JSON.stringify(hits)).not.toContain("PRIVATE_BODY");
    // Nothing is pinned in this session, so a pinned-only partition yields no hits.
    expect(
      await index.search(query("billing webhook", [{ ...personal, pinnedIn: "child" }]))
    ).toEqual([]);
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
      for (const text of ["billing webhook deduplication", "common"]) {
        const durations: number[] = [];
        for (let repeat = 0; repeat < 5; repeat++) {
          const start = performance.now();
          const hits = await new LexicalFactIndex(measured).search(query(text, [personal]));
          durations.push(performance.now() - start);
          expect(hits.length).toBe(text === "common" ? 11 : 1);
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
          query: text,
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
