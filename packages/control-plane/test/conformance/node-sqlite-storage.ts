/**
 * Test storage over `node:sqlite`: the same `SqlStorage` + `TransactionSync`
 * surface a Durable Object supplies, backed by an in-process database, so the
 * repository suites and the schema tests can run without a Workers runtime.
 *
 * No SQL text is interpreted here. Whether a call is one statement or a script
 * comes from the prepared statement's own extent, rows come from stepping it,
 * and the write count comes from SQLite's change counter.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqlResult, SqlStorage, TransactionSync } from "../../src/session/sql-storage";

export interface NodeSqlStorage {
  sql: SqlStorage;
  transactionSync: TransactionSync;
}

export function createNodeSqlStorage(db: DatabaseSync): NodeSqlStorage {
  const totalChanges = db.prepare("SELECT total_changes() AS n");
  const changesSince = (before: number): number =>
    Number((totalChanges.get() as { n: number | bigint }).n) - before;

  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      const before = Number((totalChanges.get() as { n: number | bigint }).n);
      const statement = db.prepare(query);
      // sourceSQL is the text SQLite consumed for this one statement; anything
      // after it is a further statement, which makes the call a script.
      const remainder = query.slice(statement.sourceSQL.length).trim();
      if (remainder.length > 0) {
        if (params.length > 0) {
          throw new Error("Parameters cannot be bound to a multi-statement script");
        }
        db.exec(query);
        return { toArray: () => [], one: () => null, rowsWritten: changesSince(before) };
      }
      // Stepping to completion returns the rows of a read or a RETURNING
      // clause and an empty list for any other write.
      const rows = statement.all(...(params as SQLInputValue[]));
      return {
        toArray: () => rows,
        one: () => exactlyOne(rows),
        rowsRead: rows.length,
        rowsWritten: changesSince(before),
      };
    },
  };

  // Nested calls become savepoints, matching the Durable Object's
  // transactionSync, so a repository transaction inside a service transaction
  // commits or rolls back as one unit.
  let depth = 0;
  const transactionSync: TransactionSync = (closure) => {
    const savepoint = `sp_${depth}`;
    db.exec(depth === 0 ? "BEGIN" : `SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const result = closure();
      db.exec(depth === 1 ? "COMMIT" : `RELEASE ${savepoint}`);
      return result;
    } catch (error) {
      db.exec(depth === 1 ? "ROLLBACK" : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      throw error;
    } finally {
      depth -= 1;
    }
  };

  return { sql, transactionSync };
}

/** Durable Object cursors throw from `one()` unless the result is a single row. */
function exactlyOne(rows: unknown[]): unknown {
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one row, got ${rows.length}`);
  }
  return rows[0];
}
