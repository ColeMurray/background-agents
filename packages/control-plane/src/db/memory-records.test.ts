import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memorySearchTerms } from "@open-inspect/shared/types/memories";
import { seedSearchFacts } from "../../test/conformance/memory-search-fixtures";
import { applyMigrations } from "../node/migrate";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { MemoryRecordStore } from "./memory-records";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface MeasuredCall {
  query: string;
  values: unknown[];
  columns: string[];
  count: number;
  batched: boolean;
}

/** Record each statement's SQL, bound values, and returned shape, including batched ones. */
function measure(db: SqlDatabase): {
  db: SqlDatabase;
  calls: MeasuredCall[];
  batches: number[];
  preparedAtBatch: number[];
} {
  const calls: MeasuredCall[] = [];
  /** Statement count of each batch() call, in order. */
  const batches: number[] = [];
  /** Statements prepared so far when each batch() call ran. */
  const preparedAtBatch: number[] = [];
  const originals = new WeakMap<SqlStatement, { statement: SqlStatement; call: MeasuredCall }>();
  const record = (call: MeasuredCall, rows: unknown[]) => {
    call.columns = Object.keys((rows[0] ?? {}) as object);
    call.count = rows.length;
  };
  return {
    calls,
    batches,
    preparedAtBatch,
    db: {
      prepare(query) {
        const statement = db.prepare(query);
        return {
          ...statement,
          bind(...values) {
            const call = { query, values, columns: [] as string[], count: 0, batched: false };
            calls.push(call);
            const bound = statement.bind(...values);
            const wrapped: SqlStatement = {
              ...bound,
              async all<T>() {
                const result = await bound.all<T>();
                record(call, result.results);
                return result;
              },
            };
            originals.set(wrapped, { statement: bound, call });
            return wrapped;
          },
        };
      },
      async batch<T>(statements: SqlStatement[]) {
        batches.push(statements.length);
        preparedAtBatch.push(calls.length);
        const entries = statements.map((statement) => originals.get(statement)!);
        const results = await db.batch<T>(entries.map((entry) => entry.statement));
        results.forEach((result, index) => {
          entries[index].call.batched = true;
          record(entries[index].call, result.results);
        });
        return results;
      },
    },
  };
}

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

  it("merges metadata snapshots for deep offsets, then loads only final-page revision bodies", async () => {
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
    const { db: measured, calls } = measure(db);
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
    const candidates = calls.filter((call) => call.query.startsWith("SELECT m.*, r.title"));
    const bodies = calls.filter((call) =>
      call.query.startsWith("SELECT id, content FROM memory_revisions")
    );
    expect(candidates).toHaveLength(2);
    for (const call of candidates) {
      expect(call.batched).toBe(true);
      expect(call.columns).toContain("current_revision_id");
      expect(call.columns).toContain("status");
      expect(call.columns).toContain("title");
      expect(call.columns).not.toContain("content");
    }
    expect(bodies).toHaveLength(2);
    expect(bodies.reduce((total, call) => total + call.count, 0)).toBe(101);
    for (const call of calls)
      expect(call.values.length).toBeLessThanOrEqual(MAX_D1_QUERY_PARAMETERS);
  });

  const repositories = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      type: "repository" as const,
      repoId: index + 1,
    }));
  /** Facts spread across `partitions` with frequent `updatedAt` ties broken by ID. */
  const spreadFacts = (partitions: { type: "repository"; repoId: number }[], count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `fact-${String(index).padStart(3, "0")}`,
      partition: partitions[(index * 7) % partitions.length],
      title: index % 3 ? "Needle routine" : "Routine",
      content: `Body ${index}`,
      updatedAt: index % 4,
    }));
  const expectedPage = (
    facts: ReturnType<typeof spreadFacts>,
    options: { offset: number; limit: number; needle: boolean }
  ) =>
    facts
      .filter((fact) => !options.needle || fact.title.startsWith("Needle"))
      .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : 1))
      .slice(options.offset, options.offset + options.limit)
      .map((fact) => [fact.id, fact.content]);

  it.each([
    { partitions: 30, offset: 0, needle: false },
    { partitions: 30, offset: 37, needle: true },
    { partitions: 60, offset: 0, needle: false },
    { partitions: 60, offset: 37, needle: true },
  ])(
    "returns the same global page through single-statement and chunked paths (%o)",
    async ({ partitions: count, offset, needle }) => {
      const partitions = repositories(count);
      const facts = spreadFacts(partitions, 180);
      await seedSearchFacts(db, "owner", facts);
      const { db: measured, calls } = measure(db);
      const result = await new MemoryRecordStore(measured).listPartitions(partitions, {
        status: "active",
        offset,
        limit: 51,
        terms: needle ? ["needle"] : [],
      });
      expect(result.map((record) => [record.id, record.content])).toEqual(
        expectedPage(facts, { offset, limit: 51, needle })
      );
      // Up to one statement's worth of partitions, the page is read in a single query.
      if (count <= 47) expect(calls).toHaveLength(1);
      else expect(calls.length).toBeGreaterThan(1);
    }
  );

  it("selects the single-statement page before joining revision bodies", async () => {
    const partitions = repositories(10);
    await seedSearchFacts(db, "owner", spreadFacts(partitions, 40));
    const { db: measured, calls } = measure(db);
    await new MemoryRecordStore(measured).listPartitions(partitions, {
      status: "active",
      offset: 20,
      limit: 5,
      terms: [],
    });
    expect(calls).toHaveLength(1);
    // Ordering and paging happen over IDs alone; the outer query loads only the page's content.
    expect(calls[0].query).toMatch(/JOIN \(SELECT m\.id FROM memories m\s+WHERE/);
    expect(calls[0].count).toBe(5);
  });

  it("batches candidate chunks in bounded groups", async () => {
    // Without search, each statement binds 48 partitions: 200 partitions make five chunks.
    const partitions = repositories(200);
    const facts = spreadFacts(partitions, 300);
    await seedSearchFacts(db, "owner", facts);
    const { db: measured, calls, batches, preparedAtBatch } = measure(db);
    const result = await new MemoryRecordStore(measured).listPartitions(partitions, {
      status: "active",
      offset: 0,
      limit: 51,
      terms: [],
    });
    expect(result.map((record) => [record.id, record.content])).toEqual(
      expectedPage(facts, { offset: 0, limit: 51, needle: false })
    );
    expect(batches).toEqual([4, 1]);
    // Each batch's statements are prepared only when it runs, not for the whole catalog up front.
    expect(preparedAtBatch).toEqual([4, 5]);
    expect(calls.filter((call) => call.query.startsWith("SELECT m.*")).length).toBe(5);
  });

  it("lists shared partitions with records of a status from identity alone", async () => {
    await seedSearchFacts(db, "owner", [
      { id: "repo-active", partition: { type: "repository", repoId: 42 } },
      { id: "repo-active-2", partition: { type: "repository", repoId: 42 } },
      { id: "repo-archived", partition: { type: "repository", repoId: 7 }, status: "archived" },
      { id: "env-active", partition: { type: "environment", environmentId: "env-1" } },
      { id: "personal-active", partition: { type: "personal", userId: "owner" } },
    ]);
    const partitions = await new MemoryRecordStore(db).sharedPartitions("active");
    expect(partitions).toHaveLength(2);
    expect(partitions).toEqual(
      expect.arrayContaining([
        { type: "repository", repoId: 42 },
        { type: "environment", environmentId: "env-1" },
      ])
    );
    expect(await new MemoryRecordStore(db).sharedPartitions("archived")).toEqual([
      { type: "repository", repoId: 7 },
    ]);
  });

  it.each(["archive", "edit"] as const)(
    "retains selected metadata, content, and continuation after a concurrent %s before hydration",
    async (action) => {
      const partitions = Array.from({ length: 60 }, (_, index) => ({
        type: "repository" as const,
        repoId: index + 1,
      }));
      await seedSearchFacts(
        db,
        "owner",
        ["a", "b", "c", "d"].map((id, index) => ({
          id,
          partition: partitions[index],
          title: "Needle",
          content: `Original body ${id}`,
          updatedAt: 4 - index,
        }))
      );
      const store = new MemoryRecordStore(db);
      const expected = await Promise.all(["a", "b", "c"].map((id) => store.get(id)));
      const prepare = db.prepare.bind(db);
      let changed = false;
      // Change the record after the candidate merge, just before its body is hydrated.
      const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
        const statement = prepare(query);
        if (!query.startsWith("SELECT id, content FROM memory_revisions")) return statement;
        return {
          ...statement,
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              ...bound,
              async all<T>() {
                if (!changed) {
                  changed = true;
                  const actor = { kind: "user" as const, userId: "owner", requestId: "race" };
                  if (action === "archive") await store.transition("b", "archive", "rev_b", actor);
                  else
                    await store.revise(
                      "b",
                      {
                        memoryType: "fact",
                        title: "Different knowledge",
                        description: "No longer matches the search",
                        content: "A new body for the edited record",
                      },
                      "rev_b",
                      actor
                    );
                }
                return bound.all<T>();
              },
            };
          },
        };
      });
      try {
        // Page size two plus the extra-row sentinel; d is still a matching continuation.
        const records = await store.listPartitions(partitions, {
          status: "active",
          offset: 0,
          limit: 3,
          terms: ["needle"],
        });
        expect(changed).toBe(true);
        expect(records).toEqual(expected);
        expect(records.length > 2 ? 2 : null).toBe(2);
        expect(await store.get("b")).not.toEqual(records[1]);
        expect(await store.get("d")).toMatchObject({ status: "active", title: "Needle" });
      } finally {
        spy.mockRestore();
      }
    }
  );
});
