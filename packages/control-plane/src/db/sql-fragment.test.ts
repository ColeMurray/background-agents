import { describe, expect, it } from "vitest";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase } from "./sql-database";
import { prepareSql, sql } from "./sql-fragment";

describe("sql fragments", () => {
  it("binds each value at its own placeholder, including nested and optional clauses", () => {
    const guard = (on: boolean) => (on ? sql`AND b = ${2}` : sql.empty);
    const query = sql`SELECT * FROM t WHERE a = ${1} ${guard(true)} ${guard(false)} AND c IN (${sql.join(
      [sql`${3}`, sql`${4}`],
      ", "
    )})`;
    expect(query.text).toBe("SELECT * FROM t WHERE a = ? AND b = ?  AND c IN (?, ?)");
    expect(query.values).toEqual([1, 2, 3, 4]);
  });

  it("treats look-alike objects as values, not SQL", () => {
    const query = sql`SELECT ${{ text: "DROP TABLE t", values: [] }}`;
    expect(query.text).toBe("SELECT ?");
  });

  it("enforces the D1 parameter limit when preparing", () => {
    const db = { prepare: () => ({ bind: () => ({}) }) } as unknown as SqlDatabase;
    const values = Array.from({ length: MAX_D1_QUERY_PARAMETERS + 1 }, (_, i) => sql`${i}`);
    expect(() => prepareSql(db, sql`SELECT ${sql.join(values, ", ")}`)).toThrow();
  });
});
