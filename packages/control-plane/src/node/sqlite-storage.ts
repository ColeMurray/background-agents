/**
 * Session storage over `node:sqlite`: the `SqlStorage` + `TransactionSync`
 * surface a Durable Object supplies, backed by an in-process database, so the
 * session core runs unchanged on a Node host.
 *
 * `node:sqlite` was chosen over better-sqlite3 because it ships with the Node
 * release CI already pins (unflagged since 22.13), so the host adds no native
 * dependency to install or rebuild. better-sqlite3 exposes the same
 * prepare/run/all shape and is the fallback if a gap appears here.
 *
 * No SQL text is interpreted here. Whether a call is one statement or a script
 * comes from the prepared statement's own extent, rows come from stepping it,
 * and the write count comes from SQLite's change counter. Foreign keys are
 * enforced, as they are in Durable Object storage. The conformance suite
 * (test/conformance) pins every semantic the core relies on to what the
 * Durable Object does, including nested transactions as savepoints.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SessionStorage } from "../session/platform";
import type { SqlResult, SqlStorage, TransactionSync } from "../session/sql-storage";

export function createNodeSqlStorage(db: DatabaseSync): SessionStorage {
  const totalChanges = db.prepare("SELECT total_changes() AS n");
  const changesSince = (before: number): number =>
    Number((totalChanges.get() as { n: number | bigint }).n) - before;

  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      const statement = db.prepare(query);
      const before = Number((totalChanges.get() as { n: number | bigint }).n);
      // sourceSQL is the text SQLite consumed for this one statement; anything
      // after it is a further statement, which makes the call a script.
      const remainder = query.slice(statement.sourceSQL.length).trim();
      if (remainder.length > 0) {
        if (params.length > 0) {
          throw new Error("Parameters cannot be bound to a multi-statement script");
        }
        db.exec(query);
        return { toArray: () => [], one: () => exactlyOne([]), rowsWritten: changesSince(before) };
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
