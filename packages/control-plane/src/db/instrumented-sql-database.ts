/**
 * Instrumented SqlDatabase wrapper for per-request query timing.
 *
 * Wraps a SqlDatabase so that every query's wall-clock time and engine-reported
 * metadata (server duration, rows read/written) are recorded into a
 * RequestMetrics collector. The collector is created once per HTTP request
 * and its summary is spread into the http.request wide event.
 *
 * The router injects the instrumented database into RequestContext (`ctx.db`);
 * stores accept the SqlDatabase port and receive it transparently.
 */

import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Record of a single query execution against the global store, whichever
 * engine serves it. Only `query_ms` is always present: the engine metadata
 * is optional on `SqlResultMeta`, and `first()` reports none, so a field an
 * engine did not report stays absent here and in the summary rather than
 * reading as a measured zero.
 */
interface SqlQueryRecord {
  /** Wall-clock time in ms, as the caller saw it (on Workers this includes the round-trip to the D1 primary). */
  query_ms: number;
  /** Engine-reported execution time in ms (`meta.duration`), when the engine reports one. */
  engine_ms?: number;
  /** Rows read, when the engine reports it. */
  rows_read?: number;
  /** Rows written, when the engine reports it. */
  rows_written?: number;
}

type ReportedField = "engine_ms" | "rows_read" | "rows_written";

/** The sum of `field` over the records that report it; absent when none does. */
function reportedTotal(
  records: readonly Pick<SqlQueryRecord, ReportedField>[],
  field: ReportedField
): number | undefined {
  let total: number | undefined;
  for (const record of records) {
    const value = record[field];
    if (value !== undefined) total = (total ?? 0) + value;
  }
  return total;
}

/**
 * Per-request metrics accumulator. Created once per HTTP request, passed
 * through RequestContext, and summarized into the http.request wide event.
 */
export interface RequestMetrics {
  /** Accumulated query records (populated by the instrumentSqlDatabase wrapper). */
  readonly sqlQueries: SqlQueryRecord[];

  /** Named timing spans for non-database operations (populated via time()). */
  readonly spans: Record<string, number>;

  /**
   * Time an arbitrary async operation and record it as a named span.
   * The span name becomes a field in the wide event with `_ms` suffix.
   */
  time<T>(name: string, fn: () => Promise<T>): Promise<T>;

  /**
   * Compute summary fields for the wide event.
   * Returns a flat record ready to spread into the logger data object.
   */
  summarize(): Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Metrics collector
// ---------------------------------------------------------------------------

export function createRequestMetrics(): RequestMetrics {
  const sqlQueries: SqlQueryRecord[] = [];
  const spans: Record<string, number> = {};

  return {
    sqlQueries,
    spans,

    async time<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const start = Date.now();
      try {
        return await fn();
      } finally {
        spans[name] = Date.now() - start;
      }
    },

    summarize(): Record<string, unknown> {
      const result: Record<string, unknown> = {
        sql_query_count: sqlQueries.length,
        sql_total_ms: sqlQueries.reduce((sum, q) => sum + q.query_ms, 0),
      };
      // Reported by the engine or not in the event at all: a Node SQLite
      // store reports no rows_read, and a request of only first() calls
      // reports nothing, so a zero here would be a measurement that never
      // happened.
      const engineMs = reportedTotal(sqlQueries, "engine_ms");
      if (engineMs !== undefined) result.sql_engine_total_ms = engineMs;
      const rowsRead = reportedTotal(sqlQueries, "rows_read");
      if (rowsRead !== undefined) result.sql_rows_read = rowsRead;
      const rowsWritten = reportedTotal(sqlQueries, "rows_written");
      if (rowsWritten !== undefined) result.sql_rows_written = rowsWritten;

      for (const [name, ms] of Object.entries(spans)) {
        result[`${name}_ms`] = ms;
      }

      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Statement wrapper
// ---------------------------------------------------------------------------

/** Symbol used to store the original SqlStatement on instrumented wrappers. */
const ORIGINAL_STMT = Symbol("originalSqlStatement");

type WrappedStatement = SqlStatement & { [ORIGINAL_STMT]?: SqlStatement };

/** Extract the underlying SqlStatement from an instrumented wrapper (or return as-is). */
function unwrapStatement(stmt: SqlStatement): SqlStatement {
  return (stmt as WrappedStatement)[ORIGINAL_STMT] ?? stmt;
}

/**
 * Wrap a SqlStatement to time its terminal methods (run, first, all).
 * bind() returns a new instrumented statement so chaining works correctly.
 *
 * The original statement is stored via ORIGINAL_STMT so that batch() can
 * unwrap instrumented statements before passing them to the real database
 * (which can only execute its own statements — see the same-origin contract
 * in sql-database.ts).
 */
function instrumentStatement(stmt: SqlStatement, metrics: RequestMetrics): SqlStatement {
  const wrapper: WrappedStatement = {
    bind(...values: unknown[]): SqlStatement {
      return instrumentStatement(stmt.bind(...values), metrics);
    },

    async first<T = Record<string, unknown>>(): Promise<T | null> {
      const start = Date.now();
      const result = await stmt.first<T>();
      metrics.sqlQueries.push({ query_ms: Date.now() - start });
      return result;
    },

    async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
      const start = Date.now();
      const result = await stmt.run<T>();
      metrics.sqlQueries.push({
        query_ms: Date.now() - start,
        engine_ms: result.meta?.duration,
        rows_read: result.meta?.rows_read,
        rows_written: result.meta?.rows_written,
      });
      return result;
    },

    async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
      const start = Date.now();
      const result = await stmt.all<T>();
      metrics.sqlQueries.push({
        query_ms: Date.now() - start,
        engine_ms: result.meta?.duration,
        rows_read: result.meta?.rows_read,
        rows_written: result.meta?.rows_written,
      });
      return result;
    },
  };

  wrapper[ORIGINAL_STMT] = stmt;
  return wrapper;
}

// ---------------------------------------------------------------------------
// Database wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a SqlDatabase to automatically record timing for all queries.
 *
 * Uses object composition: the stores accept the SqlDatabase port in their
 * constructor — passing an instrumented DB means all their queries are timed
 * without any changes to the store code.
 */
export function instrumentSqlDatabase(db: SqlDatabase, metrics: RequestMetrics): SqlDatabase {
  return {
    prepare(query: string): SqlStatement {
      return instrumentStatement(db.prepare(query), metrics);
    },

    async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      const start = Date.now();
      const results = await db.batch<T>(statements.map(unwrapStatement));
      const elapsed = Date.now() - start;

      // One record for the batch, each field the sum over the statements
      // whose engine reported it.
      const reported = results.map((r) => ({
        engine_ms: r.meta?.duration,
        rows_read: r.meta?.rows_read,
        rows_written: r.meta?.rows_written,
      }));
      metrics.sqlQueries.push({
        query_ms: elapsed,
        engine_ms: reportedTotal(reported, "engine_ms"),
        rows_read: reportedTotal(reported, "rows_read"),
        rows_written: reportedTotal(reported, "rows_written"),
      });

      return results;
    },
  };
}
