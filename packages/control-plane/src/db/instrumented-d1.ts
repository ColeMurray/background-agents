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

/** Record of a single D1 query execution. */
export interface D1QueryRecord {
  /** Wall-clock time in ms (includes network round-trip from Worker to D1 primary). */
  query_ms: number;
  /** Engine-reported server-side execution time in ms (from meta.duration). */
  d1_server_ms?: number;
  /** Rows read, from result meta. */
  rows_read?: number;
  /** Rows written, from result meta. */
  rows_written?: number;
}

/**
 * Per-request metrics accumulator. Created once per HTTP request, passed
 * through RequestContext, and summarized into the http.request wide event.
 */
export interface RequestMetrics {
  /** Accumulated D1 query records (populated automatically by instrumentD1 wrapper). */
  readonly d1Queries: D1QueryRecord[];

  /** Named timing spans for non-D1 operations (populated via time()). */
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
  const d1Queries: D1QueryRecord[] = [];
  const spans: Record<string, number> = {};

  return {
    d1Queries,
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
        d1_query_count: d1Queries.length,
        d1_total_ms: d1Queries.reduce((sum, q) => sum + q.query_ms, 0),
        d1_server_total_ms: d1Queries.reduce((sum, q) => sum + (q.d1_server_ms ?? 0), 0),
        d1_rows_read: d1Queries.reduce((sum, q) => sum + (q.rows_read ?? 0), 0),
        d1_rows_written: d1Queries.reduce((sum, q) => sum + (q.rows_written ?? 0), 0),
      };

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
      metrics.d1Queries.push({ query_ms: Date.now() - start });
      return result;
    },

    async run<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
      const start = Date.now();
      const result = await stmt.run<T>();
      metrics.d1Queries.push({
        query_ms: Date.now() - start,
        d1_server_ms: result.meta?.duration,
        rows_read: result.meta?.rows_read,
        rows_written: result.meta?.rows_written,
      });
      return result;
    },

    async all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
      const start = Date.now();
      const result = await stmt.all<T>();
      metrics.d1Queries.push({
        query_ms: Date.now() - start,
        d1_server_ms: result.meta?.duration,
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
export function instrumentD1(db: SqlDatabase, metrics: RequestMetrics): SqlDatabase {
  return {
    prepare(query: string): SqlStatement {
      return instrumentStatement(db.prepare(query), metrics);
    },

    async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
      const start = Date.now();
      const results = await db.batch<T>(statements.map(unwrapStatement));
      const elapsed = Date.now() - start;

      let serverMs = 0;
      let rowsRead = 0;
      let rowsWritten = 0;
      for (const r of results) {
        serverMs += r.meta?.duration ?? 0;
        rowsRead += r.meta?.rows_read ?? 0;
        rowsWritten += r.meta?.rows_written ?? 0;
      }

      metrics.d1Queries.push({
        query_ms: elapsed,
        d1_server_ms: serverMs,
        rows_read: rowsRead,
        rows_written: rowsWritten,
      });

      return results;
    },
  };
}
