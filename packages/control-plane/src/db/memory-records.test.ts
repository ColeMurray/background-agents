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
    const candidates = calls.filter((call) => call.query.startsWith("SELECT m.*, r.title"));
    const bodies = calls.filter((call) =>
      call.query.startsWith("SELECT id, content FROM memory_revisions")
    );
    expect(candidates).toHaveLength(2);
    for (const call of candidates) {
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
      let candidateReads = 0;
      const spy = vi.spyOn(db, "prepare").mockImplementation((query) => {
        const statement = prepare(query);
        if (!query.startsWith("SELECT m.")) return statement;
        return {
          ...statement,
          bind(...values) {
            const bound = statement.bind(...values);
            return {
              ...bound,
              async all<T>() {
                const result = await bound.all<T>();
                if (++candidateReads === 2) {
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
                return result;
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
