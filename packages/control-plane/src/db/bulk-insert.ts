import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/**
 * Build multi-row INSERTs for a row list whose length the caller does not control.
 *
 * One statement per row makes a write linear in row count against the engine's
 * per-invocation query budget; one statement covering every row blows the
 * bound-parameter ceiling. Packing floor(ceiling / columns) rows into each
 * statement divides the statement count by that factor.
 *
 * That is a smaller constant, not count-independence: this returns as many
 * statements as the rows require and knows nothing about the caller's other
 * queries, so the end-to-end invocation budget stays the caller's problem. See
 * the bounds table in docs/plans/managed-skills.md for the surviving cliffs.
 *
 * Rows are column-keyed objects rather than positional tuples so a column can
 * never drift from its value: the column list comes from the rows themselves,
 * and each row is read back by key rather than by position.
 *
 * The result is ordinary parameterized SQL, so callers splice it into an
 * existing batch() and keep the surrounding write atomic. Multi-row VALUES is
 * standard SQL, so this needs no engine branch.
 *
 * `table` and the row keys are interpolated into the statement text: pass
 * literals, never anything derived from a request.
 */
export function bulkInsertStatements(
  db: SqlDatabase,
  table: string,
  rows: readonly Readonly<Record<string, unknown>>[]
): SqlStatement[] {
  const [first] = rows;
  if (!first) return [];
  const columns = Object.keys(first);
  if (columns.length === 0) {
    throw new Error(`Cannot bulk insert into ${table}: rows have no columns`);
  }
  const rowsPerStatement = Math.floor(MAX_D1_QUERY_PARAMETERS / columns.length);
  if (rowsPerStatement < 1) {
    throw new Error(
      `Cannot bulk insert into ${table}: ${columns.length} columns exceeds the parameter ceiling`
    );
  }
  const expected = new Set(columns);
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const statements: SqlStatement[] = [];
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const chunk = rows.slice(start, start + rowsPerStatement);
    const values: unknown[] = [];
    for (const row of chunk) {
      const keys = Object.keys(row);
      if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
        throw new Error(
          `Cannot bulk insert into ${table}: rows disagree on columns (${keys.join(", ")})`
        );
      }
      for (const column of columns) values.push(row[column]);
    }
    statements.push(
      db
        .prepare(
          `INSERT INTO ${table} (${columns.join(", ")})
           VALUES ${chunk.map(() => rowPlaceholder).join(", ")}`
        )
        .bind(...values)
    );
  }
  return statements;
}
