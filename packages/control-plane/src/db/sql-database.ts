/**
 * Engine-neutral SQL port for the global data layer.
 *
 * The surface is exactly what the src/db stores use today — nothing more.
 * D1Database satisfies this interface structurally (proven below), so no
 * wrapper object exists at runtime; the port is erased at build time.
 *
 * Members use method syntax deliberately: method parameters are checked
 * bivariantly, which is what lets D1Database.batch(D1PreparedStatement[])
 * satisfy batch(SqlStatement[]). Do not convert these to arrow-function
 * property signatures.
 *
 * Contract the type system cannot express: statements passed to batch() must
 * originate from the same database's prepare(). Adapters must tolerate or
 * unwrap foreign statements (see ORIGINAL_STMT in instrumented-d1.ts, which
 * exists exactly because wrapped statements cross into the raw db.batch()).
 *
 * Not to be confused with the session Durable Object's synchronous
 * `SqlStorage` (src/session/repository.ts) — that is a different engine with
 * a load-bearing sync contract, and is intentionally not covered by this port.
 */

export interface SqlResultMeta {
  /**
   * Rows written by the statement. Required, not optional: ~38 store call
   * sites gate correctness on it (CAS conflict detection, guarded lifecycle
   * transitions, upsert/insert detection), so an engine that omits it would
   * make successful writes report failure. Implementations must return real
   * affected-row counts (0 for reads).
   */
  changes: number;
}

export interface SqlResult<T = unknown> {
  results: T[];
  meta: SqlResultMeta;
}

export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
}

export interface SqlDatabase {
  prepare(query: string): SqlStatement;
  /**
   * Execute the statements in order as a single atomic transaction: either
   * every statement's effects apply or none do, all statements observe one
   * consistent snapshot, and the resolved array is positionally 1:1 with the
   * input. Consumers rely on all three (delete-then-insert replacement
   * writes, positional result destructuring, multi-query analytics reads) —
   * an implementation must not emulate this with independent round-trips.
   */
  batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]>;
}

/**
 * Compile-time proof that the Cloudflare types satisfy the port. If a
 * workers-types upgrade or a port edit ever breaks assignability, typecheck
 * fails here rather than at 100 call sites.
 */
type _AssertExtends<A extends B, B> = A;
type _D1SatisfiesDb = _AssertExtends<D1Database, SqlDatabase>;
type _D1SatisfiesStmt = _AssertExtends<D1PreparedStatement, SqlStatement>;
