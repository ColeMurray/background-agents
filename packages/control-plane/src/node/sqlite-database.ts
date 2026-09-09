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
 *   `undefined`, `bigint`, or any other object is a type error at bind time.
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
import { isStatementlessSql } from "./sqlite-sql";

export interface NodeSqlDatabase extends SqlDatabase {
  /** Close the connection. Every later statement throws. */
  close(): void;
}

/** The port over an open connection the caller owns. */
export function createNodeSqlDatabase(db: DatabaseSync): NodeSqlDatabase {
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

  // Each statement's synchronous work, keyed by the statement it belongs
  // to: the brand that admits it to batch(), and what batch() runs without
  // yielding.
  const executors = new WeakMap<SqlStatement, StatementExecutor>();

  const statementFor = (query: string, params: SQLInputValue[]): SqlStatement => {
    const executor: StatementExecutor = {
      all: <T>() => execute<T>(query, params),
      first: <T>() => (prepareOne(db, query).get(...params) as T | undefined) ?? null,
    };
    const statement: SqlStatement = {
      bind: (...values) => statementFor(query, values.map(toBoundValue)),
      first: async <T>() => executor.first<T>(),
      run: async <T>() => executor.all<T>(),
      all: async <T>() => executor.all<T>(),
    };
    executors.set(statement, executor);
    return statement;
  };

  return {
    prepare: (query) => statementFor(query, []),
    async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      const work = statements.map((statement) => {
        const executor = executors.get(statement);
        if (!executor) {
          throw new TypeError("batch() accepts only statements prepared by this database");
        }
        return executor;
      });
      // Nothing yields between BEGIN and COMMIT: the transaction opens and
      // closes within this call, so no other caller's statement can land
      // inside it.
      db.exec("BEGIN IMMEDIATE");
      try {
        const results = work.map((executor) => executor.all<T>());
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

interface StatementExecutor {
  all<T>(): SqlResult<T>;
  first<T>(): T | null;
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

/**
 * The value as SQLite binds it, with D1's conversions and rejections. The
 * accepted set is what both engines take: `node:sqlite` would also bind a
 * `bigint`, but D1 rejects one, so store code that bound it would pass on
 * Node and fail on Workers.
 */
function toBoundValue(value: unknown): SQLInputValue {
  if (value === null) return null;
  switch (typeof value) {
    case "number":
    case "string":
      return value;
    case "boolean":
      return value ? 1 : 0;
    default:
      break;
  }
  // Copied at bind time, as D1 snapshots binary values: a later mutation of
  // the caller's buffer does not change what runs.
  if (value instanceof ArrayBuffer) return new Uint8Array(value).slice();
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
