import { describe, expect, it } from "vitest";
import { bulkInsertStatements } from "./bulk-insert";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface Recorded {
  sql: string;
  values: unknown[];
}

/** Capture prepared SQL and bound values without an engine. */
function recordingDb(): { db: SqlDatabase; recorded: Recorded[] } {
  const recorded: Recorded[] = [];
  const db: SqlDatabase = {
    prepare(sql: string): SqlStatement {
      const entry: Recorded = { sql, values: [] };
      recorded.push(entry);
      const statement: SqlStatement = {
        bind(...values: unknown[]) {
          entry.values = values;
          return statement;
        },
        first: async () => null,
        run: async () => ({ results: [], meta: { changes: 0 } }),
        all: async () => ({ results: [], meta: { changes: 0 } }),
      };
      return statement;
    },
    batch: async () => [],
  };
  return { db, recorded };
}

function rows(count: number, width: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, row) =>
    Object.fromEntries(
      Array.from({ length: width }, (_, column) => [`c${column}`, `r${row}c${column}`])
    )
  );
}

describe("bulkInsertStatements", () => {
  it("emits nothing for an empty row list", () => {
    const { db, recorded } = recordingDb();
    expect(bulkInsertStatements(db, "t", [])).toEqual([]);
    expect(recorded).toHaveLength(0);
  });

  it("packs one statement per full parameter budget", () => {
    const { db, recorded } = recordingDb();
    // 10 columns => 10 rows per statement; 101 rows is one full set past ten.
    const statements = bulkInsertStatements(db, "session_skill_revisions", rows(101, 10));

    expect(statements).toHaveLength(11);
    expect(recorded.slice(0, 10).map((entry) => entry.values.length)).toEqual(Array(10).fill(100));
    expect(recorded[10]?.values).toHaveLength(10);
  });

  it("keeps every statement within the engine parameter ceiling", () => {
    for (const width of [1, 2, 3, 7, 10, 33, 100]) {
      const { db, recorded } = recordingDb();
      bulkInsertStatements(db, "t", rows(257, width));
      for (const entry of recorded) {
        expect(entry.values.length).toBeLessThanOrEqual(MAX_D1_QUERY_PARAMETERS);
        expect(entry.sql.split("?")).toHaveLength(entry.values.length + 1);
      }
      expect(recorded.reduce((total, entry) => total + entry.values.length, 0)).toBe(257 * width);
    }
  });

  it("binds values in row-major order under a multi-row VALUES clause", () => {
    const { db, recorded } = recordingDb();
    bulkInsertStatements(db, "skill_profile_items", [
      { profile_id: "p1", skill_id: "s1" },
      { profile_id: "p1", skill_id: "s2" },
    ]);

    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.sql.replace(/\s+/g, " ")).toBe(
      "INSERT INTO skill_profile_items (profile_id, skill_id) VALUES (?, ?), (?, ?)"
    );
    expect(recorded[0]?.values).toEqual(["p1", "s1", "p1", "s2"]);
  });

  it("reads each row by column name rather than by insertion order", () => {
    const { db, recorded } = recordingDb();
    bulkInsertStatements(db, "t", [
      { a: 1, b: 2 },
      { b: 4, a: 3 },
    ]);

    expect(recorded[0]?.sql).toContain("(a, b)");
    expect(recorded[0]?.values).toEqual([1, 2, 3, 4]);
  });

  it("rejects rows with no columns", () => {
    const { db } = recordingDb();
    expect(() => bulkInsertStatements(db, "t", [{}, {}])).toThrow(/rows have no columns/);
  });

  it("rejects a row whose columns disagree with the first row", () => {
    const { db } = recordingDb();
    expect(() => bulkInsertStatements(db, "t", [{ a: 1, b: 2 }, { a: 3 }])).toThrow(
      /rows disagree on columns/
    );
    expect(() =>
      bulkInsertStatements(db, "t", [
        { a: 1, b: 2 },
        { a: 3, c: 4 },
      ])
    ).toThrow(/rows disagree on columns/);
  });

  it("rejects a table too wide to insert even one row", () => {
    const { db } = recordingDb();
    expect(() => bulkInsertStatements(db, "t", rows(1, MAX_D1_QUERY_PARAMETERS + 1))).toThrow(
      /exceeds the parameter ceiling/
    );
  });
});
