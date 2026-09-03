/**
 * Session storage over `node:sqlite`: the same `SqlStorage` + `TransactionSync`
 * surface a Durable Object supplies, backed by an in-process database. Today it
 * runs the session-core conformance suite and the schema tests; the Node host
 * builds its per-session store on it.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqlResult, SqlStorage, TransactionSync } from "../session/sql-storage";

export interface NodeSqlStorage {
  sql: SqlStorage;
  transactionSync: TransactionSync;
}

/** Statements that produce rows: reads, and writes that ask for them back. */
const RETURNS_ROWS = /^\s*(?:PRAGMA|SELECT|WITH|EXPLAIN)\b|\bRETURNING\b/i;

/** A parameterless script with more than one statement; only `exec` runs those. */
function isMultiStatement(query: string): boolean {
  return /;\s*\S/.test(query.trim().replace(/;\s*$/, ""));
}

export function createNodeSqlStorage(db: DatabaseSync): NodeSqlStorage {
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      const values = params as SQLInputValue[];
      if (RETURNS_ROWS.test(query)) {
        const rows = db.prepare(query).all(...values);
        return { toArray: () => rows, one: () => rows[0] ?? null, rowsRead: rows.length };
      }
      if (values.length === 0 && isMultiStatement(query)) {
        db.exec(query);
        return { toArray: () => [], one: () => null };
      }
      const { changes } = db.prepare(query).run(...values);
      return { toArray: () => [], one: () => null, rowsWritten: Number(changes) };
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
