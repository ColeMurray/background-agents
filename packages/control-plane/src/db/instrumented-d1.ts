/**
 * Instrumented D1 wrapper for per-request query timing.
 *
 * Wraps a D1Database so that every query's wall-clock time and D1-reported
 * metadata (server duration, rows read/written) are recorded into a
 * RequestMetrics collector. The collector is created once per HTTP request
 * and its summary is spread into the http.request wide event.
 *
 * No changes required to SessionIndexStore, RepoMetadataStore, or
 * RepoSecretsStore — they receive the instrumented DB transparently.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Record of a single D1 query execution. */
export interface D1QueryRecord {
  /** Wall-clock time in ms (includes network round-trip from Worker to D1 primary). */
  query_ms: number;
  /** D1-reported server-side execution time in ms (from D1Meta.duration). */
  d1_server_ms?: number;
  /** Rows read, from D1Meta. */
  rows_read?: number;
  /** Rows written, from D1Meta. */
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
// D1 statement wrapper
// ---------------------------------------------------------------------------

/** Symbol used to store the original D1PreparedStatement on instrumented wrappers. */
const ORIGINAL_STMT = Symbol("originalD1Statement");

/** Extract the underlying D1PreparedStatement from an instrumented wrapper (or return as-is). */
function unwrapStatement(stmt: D1PreparedStatement): D1PreparedStatement {
  return (stmt as unknown as Record<symbol, D1PreparedStatement>)[ORIGINAL_STMT] ?? stmt;
}

/**
 * Wrap a D1PreparedStatement to time its terminal methods (run, first, all, raw).
 * bind() returns a new instrumented statement so chaining works correctly.
 *
 * The original statement is stored via ORIGINAL_STMT so that batch() can
 * unwrap instrumented statements before passing them to the real D1.
 */
function instrumentStatement(
  stmt: D1PreparedStatement,
  metrics: RequestMetrics
): D1PreparedStatement {
  const wrapper = {
    bind(...values: unknown[]): D1PreparedStatement {
      return instrumentStatement(stmt.bind(...values), metrics);
    },

    async first<T = unknown>(colName?: string): Promise<T | null> {
      const start = Date.now();
      const result = colName
        ? await (stmt.first as (col: string) => Promise<unknown>)(colName)
        : await stmt.first<T>();
      metrics.d1Queries.push({ query_ms: Date.now() - start });
      return result as T | null;
    },

    async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
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

    async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
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

    async raw(options?: Record<string, unknown>) {
      const start = Date.now();
      const result = await (
        stmt as unknown as { raw: (o?: Record<string, unknown>) => Promise<unknown[]> }
      ).raw(options);
      metrics.d1Queries.push({ query_ms: Date.now() - start });
      return result;
    },
  } as unknown as D1PreparedStatement;

  (wrapper as unknown as Record<symbol, D1PreparedStatement>)[ORIGINAL_STMT] = stmt;
  return wrapper;
}

// ---------------------------------------------------------------------------
// D1 database wrapper
// ---------------------------------------------------------------------------

/**
 * Wrap a D1Database to automatically record timing for all queries.
 *
 * Uses object composition for type safety and simplicity. The stores
 * (SessionIndexStore, RepoMetadataStore, etc.) accept D1Database in their
 * constructor — passing an instrumented DB means all their queries are
 * timed without any changes to the store code.
 */
export function instrumentD1(db: D1Database, metrics: RequestMetrics): D1Database {
  return {
    prepare(query: string): D1PreparedStatement {
      return instrumentStatement(db.prepare(query), metrics);
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
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

    exec(query: string): Promise<D1ExecResult> {
      return db.exec(query);
    },

    dump(): Promise<ArrayBuffer> {
      return db.dump();
    },
  } as D1Database;
}
