import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/**
 * Build multi-row INSERTs for a row list whose length the caller does not control.
 *
 * One statement per row makes a write linear in row count against the engine's
 * per-invocation query budget; one statement covering every row blows the
 * bound-parameter ceiling. Packing floor(ceiling / columns) rows into each
 * statement keeps every statement legal and divides the statement count by that
 * factor, which is what moves the write off the critical path.
 *
 * The result is ordinary parameterized SQL, so callers splice it into an
 * existing batch() and keep the surrounding write atomic. Multi-row VALUES is
 * standard SQL, so this needs no engine branch.
 *
 * `table` and `columns` are interpolated into the statement text: pass literals,
 * never anything derived from a request.
 */
export function bulkInsertStatements(
  db: SqlDatabase,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[]
): SqlStatement[] {
  const rowsPerStatement = Math.floor(MAX_D1_QUERY_PARAMETERS / columns.length);
  if (rowsPerStatement < 1) {
    throw new Error(
      `Cannot bulk insert into ${table}: ${columns.length} columns exceeds the parameter ceiling`
    );
  }
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const statements: SqlStatement[] = [];
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const chunk = rows.slice(start, start + rowsPerStatement);
    const values: unknown[] = [];
    for (const row of chunk) {
      if (row.length !== columns.length) {
        throw new Error(
          `Cannot bulk insert into ${table}: row has ${row.length} values for ${columns.length} columns`
        );
      }
      values.push(...row);
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
