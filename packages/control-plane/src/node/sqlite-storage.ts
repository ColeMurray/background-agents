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
 * Statement boundaries come from the prepared statements' own extents. The
 * only SQL text recognized here is statement-less trivia, which must be
 * filtered before prepare() because affected Node 22/24 releases mishandle the
 * null statement SQLite returns for such input. Rows come from stepping the
 * last statement, and the write count comes from SQLite's change counter.
 * Foreign keys are enforced, as they are in Durable Object storage. The
 * conformance suite (test/conformance) pins every semantic the core relies on
 * to what the Durable Object does, including nested transactions as savepoints.
 */

import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { SessionStorage } from "../session/platform";
import type { SqlResult, SqlStorage, TransactionSync } from "../session/sql-storage";

export function createNodeSqlStorage(db: DatabaseSync): SessionStorage {
  const totalChanges = db.prepare("SELECT total_changes() AS n");
  const changesSince = (before: number): number =>
    Number((totalChanges.get() as { n: number | bigint }).n) - before;

  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      const statements = prepareAll(db, query);
      // A script's result is its last statement's: the earlier ones run
      // first, unbound, and neither their rows nor their writes are
      // reported, exactly as a Durable Object cursor reports them.
      const last = statements.at(-1)!;
      const preceding = statements.slice(0, -1);
      for (const statement of preceding) {
        if (statement.expandedSQL !== statement.sourceSQL) {
          throw new Error(
            "When executing multiple SQL statements in a single call, only the last statement can have parameters."
          );
        }
      }
      for (const statement of preceding) {
        statement.run();
      }
      const before = Number((totalChanges.get() as { n: number | bigint }).n);
      // Stepping to completion returns the rows of a read or a RETURNING
      // clause and an empty list for any other write.
      const rows = last.all(...(params as SQLInputValue[]));
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

/**
 * Every statement in `query`, in order, each prepared from its own extent of
 * the text. SQLite decides where one statement ends; this adapter only
 * recognizes statement-less trivia before preparation. Text after the last
 * statement that is more than whitespace yet holds no statement (a comment, a
 * bare semicolon) is rejected the way a Durable Object rejects it, so SQL that
 * would fail on Cloudflare fails here too.
 */
function prepareAll(db: DatabaseSync, query: string): StatementSync[] {
  const statements: StatementSync[] = [];
  let rest = query;
  while (rest.length > 0) {
    if (isStatementlessSql(rest)) break;
    const statement = db.prepare(rest);
    statements.push(statement);
    rest = rest.slice(statement.sourceSQL.length);
  }
  if (statements.length === 0 || rest.trim().length > 0) {
    throw new Error("SQL code did not contain a statement.");
  }
  return statements;
}

/**
 * Whether SQLite would consume this input without producing a statement.
 *
 * SQLite reports success with a null statement pointer for whitespace, a BOM,
 * comments, empty statements, and input terminated by NUL. Node versions
 * before 26.8 wrap and track that pointer, then leave a dangling registry entry
 * when the wrapper is collected. Never pass that input to
 * DatabaseSync.prepare().
 */
function isStatementlessSql(sql: string): boolean {
  let index = 0;
  while (index < sql.length) {
    const char = sql[index];
    const code = sql.charCodeAt(index);
    if (code === 0x00) return true;
    if (
      char === ";" ||
      code === 0x09 ||
      code === 0x0a ||
      code === 0x0c ||
      code === 0x0d ||
      code === 0x20 ||
      code === 0xfeff
    ) {
      index += 1;
      continue;
    }
    if (char === "-" && sql[index + 1] === "-") {
      const newline = sql.indexOf("\n", index + 2);
      index = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (char === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 2;
      continue;
    }
    return false;
  }
  return true;
}

/** Durable Object cursors throw from `one()` unless the result is a single row. */
function exactlyOne(rows: unknown[]): unknown {
  if (rows.length !== 1) {
    throw new Error(`Expected exactly one row, got ${rows.length}`);
  }
  return rows[0];
}
