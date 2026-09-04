/**
 * The global store over `node:sqlite`: the `SqlDatabase` port the data layer
 * is written against, backed by one SQLite file on the host. D1 is SQLite,
 * so the stores' SQL and every migration run unchanged (decision D-1); this
 * adapter reproduces the D1 client's contract rather than its wire protocol.
 *
 * What the stores rely on and this adapter guarantees:
 *
 * - `prepare(query)` takes exactly one statement, as D1 does. SQLite would
 *   silently compile only the first statement of a longer text; trailing
 *   SQL is rejected here instead.
 * - `bind(...)` returns a new statement and validates the values the way
 *   D1 does: booleans become integers, buffers are bound as blobs, and
 *   `undefined` or any other object is a type error at bind time.
 * - `first()` is `null` when no row matches; `all()` and `run()` return the
 *   rows with `meta.changes` from SQLite's change counter, which the stores
 *   gate CAS and upsert correctness on.
 * - `batch(statements)` runs every statement inside one `BEGIN IMMEDIATE`
 *   transaction, rolls back on any throw, and returns results positionally.
 *   Only statements from this database's `prepare()` are accepted, so a
 *   statement from another engine or an unwrapped instrumented wrapper is a
 *   wiring error rather than a silent no-op.
 *
 * The connection is synchronous underneath: every method resolves in the
 * same turn it was called, which is what makes a batch a single snapshot.
 */

import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { SqlDatabase, SqlResult, SqlStatement } from "../db/sql-database";
import { applyMigrations } from "./migrate";
import { openPrivateSqliteFile } from "./sqlite-file";
import { isStatementlessSql } from "./sqlite-storage";

export interface NodeSqlDatabase extends SqlDatabase {
  /** Close the connection. Every later statement throws. */
  close(): void;
}

/** The port over an open connection the caller owns. */
export function createNodeSqlDatabase(db: DatabaseSync): NodeSqlDatabase {
  const own = new WeakSet<SqlStatement>();
  const totalChanges = db.prepare("SELECT total_changes() AS n");
  const changesNow = (): number => Number((totalChanges.get() as { n: number | bigint }).n);

  const execute = <T>(query: string, params: SQLInputValue[]): SqlResult<T> => {
    const statement = prepareOne(db, query);
    const started = performance.now();
    const before = changesNow();
    // Stepping to completion returns the rows of a read or a RETURNING
    // clause and an empty list for any other write.
    const results = statement.all(...params) as T[];
    const changes = changesNow() - before;
    return {
      results,
      meta: { changes, duration: performance.now() - started, rows_written: changes },
    };
  };

  const statementFor = (query: string, params: SQLInputValue[]): SqlStatement => {
    const statement: SqlStatement = {
      bind: (...values) => statementFor(query, values.map(toBoundValue)),
      first: async <T>() => {
        const row = prepareOne(db, query).get(...params) as T | undefined;
        return row ?? null;
      },
      run: async <T>() => execute<T>(query, params),
      all: async <T>() => execute<T>(query, params),
    };
    own.add(statement);
    return statement;
  };

  return {
    prepare: (query) => statementFor(query, []),
    async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      for (const statement of statements) {
        if (!own.has(statement)) {
          throw new TypeError("batch() accepts only statements prepared by this database");
        }
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        const results: SqlResult<T>[] = [];
        for (const statement of statements) {
          // Resolves in this turn: the statement's work is synchronous.
          results.push(await statement.all<T>());
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close: () => db.close(),
  };
}

export interface OpenNodeSqlDatabaseOptions {
  /** Apply the migrations in this directory before returning (see migrate.ts). */
  migrationsDir?: string;
}

/**
 * Open (creating if needed) the global store at `path`: private to the host
 * user, WAL mode, busy timeout, and foreign keys enforced as D1 enforces
 * them, with the schema migrated when a directory is given. The parent
 * directory must already exist.
 */
export function openNodeSqlDatabase(
  path: string,
  options: OpenNodeSqlDatabaseOptions = {}
): NodeSqlDatabase {
  const db = openPrivateSqliteFile(path);
  try {
    db.exec("PRAGMA foreign_keys = ON");
    if (options.migrationsDir !== undefined) applyMigrations(db, options.migrationsDir);
  } catch (error) {
    db.close();
    throw error;
  }
  return createNodeSqlDatabase(db);
}

/** Prepare `query`, which must hold exactly one statement, as D1 requires. */
function prepareOne(db: DatabaseSync, query: string) {
  if (isStatementlessSql(query)) {
    throw new Error("SQL code did not contain a statement.");
  }
  const statement = db.prepare(query);
  const rest = query.slice(statement.sourceSQL.length);
  if (!isStatementlessSql(rest)) {
    throw new Error("prepare() takes exactly one SQL statement.");
  }
  return statement;
}

/** The value as SQLite binds it, with D1's conversions and rejections. */
function toBoundValue(value: unknown): SQLInputValue {
  if (value === null) return null;
  switch (typeof value) {
    case "number":
    case "bigint":
    case "string":
      return value;
    case "boolean":
      return value ? 1 : 0;
    default:
      break;
  }
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice();
  }
  throw new TypeError(`Cannot bind a value of type ${describeType(value)}`);
}

function describeType(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value !== "object") return typeof value;
  return (value as object).constructor?.name ?? "object";
}
