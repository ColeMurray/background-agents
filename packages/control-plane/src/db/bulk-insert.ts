import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
import type { SqlDatabase, SqlStatement } from "./sql-database";

/**
 * Build batchable inserts using the engine's set capability when available,
 * otherwise pack portable VALUES under the bound-parameter ceiling.
 * Table/column names must be trusted store literals, never request input.
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
  const expected = new Set(columns);
  const valuesByRow = rows.map((row) => {
    const keys = Object.keys(row);
    if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) {
      throw new Error(
        `Cannot bulk insert into ${table}: rows disagree on columns (${keys.join(", ")})`
      );
    }
    return columns.map((column) => row[column]);
  });
  // Binary/undefined/non-finite values and unsafe integers retain ordinary binding.
  if (db.bulkInsert && valuesByRow.every((row) => row.every(isJsonScalar))) {
    return db.bulkInsert(table, columns, valuesByRow);
  }
  const rowsPerStatement = Math.floor(MAX_D1_QUERY_PARAMETERS / columns.length);
  if (rowsPerStatement < 1) {
    throw new Error(
      `Cannot bulk insert into ${table}: ${columns.length} columns exceeds the parameter ceiling`
    );
  }
  const rowPlaceholder = `(${columns.map(() => "?").join(", ")})`;
  const statements: SqlStatement[] = [];
  for (let start = 0; start < rows.length; start += rowsPerStatement) {
    const chunk = valuesByRow.slice(start, start + rowsPerStatement);
    const values = chunk.flat();
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

function isJsonScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" &&
      Number.isFinite(value) &&
      (!Number.isInteger(value) || Number.isSafeInteger(value)))
  );
}
