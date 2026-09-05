import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlDatabase, type NodeSqlDatabase } from "../node/sqlite-database";
import { createRequestMetrics, instrumentSqlDatabase } from "./instrumented-sql-database";
import type { RequestMetrics } from "./instrumented-sql-database";
import type { SqlDatabase, SqlResult, SqlStatement } from "./sql-database";

// ---------------------------------------------------------------------------
// A SqlDatabase whose engine reports every metadata field, as D1 does for
// run() and all(), so the wrapper's arithmetic can be checked exactly.
// ---------------------------------------------------------------------------

function result<T>(results: T[], meta: SqlResult["meta"]): SqlResult<T> {
  return { results, meta };
}

class FakeStatement implements SqlStatement {
  constructor(
    readonly query: string,
    readonly bound: unknown[] = []
  ) {}

  bind(...values: unknown[]): SqlStatement {
    return new FakeStatement(this.query, values);
  }

  async first<T>(): Promise<T | null> {
    await delay(1);
    return { id: 1, name: "test" } as T;
  }

  async run<T>(): Promise<SqlResult<T>> {
    await delay(1);
    return result<T>([], { changes: 1, duration: 5, rows_read: 0, rows_written: 1 });
  }

  async all<T>(): Promise<SqlResult<T>> {
    await delay(1);
    return result([{ id: 1 }, { id: 2 }] as T[], {
      changes: 0,
      duration: 8,
      rows_read: 10,
      rows_written: 0,
    });
  }
}

class FakeDatabase implements SqlDatabase {
  /** Statements received by the last batch() call, for assertion. */
  lastBatchStatements: SqlStatement[] = [];

  prepare(query: string): SqlStatement {
    return new FakeStatement(query);
  }

  async batch<T>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    this.lastBatchStatements = statements;
    await delay(1);
    return statements.map(() =>
      result([{ id: 1 }] as T[], { changes: 2, duration: 3, rows_read: 5, rows_written: 2 })
    );
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createRequestMetrics", () => {
  let metrics: RequestMetrics;

  beforeEach(() => {
    metrics = createRequestMetrics();
  });

  it("starts with empty queries and spans", () => {
    expect(metrics.sqlQueries).toEqual([]);
    expect(metrics.spans).toEqual({});
  });

  it("summarize() reports the count and the caller-observed time alone when nothing ran", () => {
    expect(metrics.summarize()).toEqual({ sql_query_count: 0, sql_total_ms: 0 });
  });

  describe("time()", () => {
    it("records named spans", async () => {
      await metrics.time("github_api", async () => {
        await delay(5);
        return "result";
      });

      expect(metrics.spans["github_api"]).toBeGreaterThanOrEqual(4);
    });

    it("returns the wrapped function's result", async () => {
      const result = await metrics.time("test_op", async () => 42);
      expect(result).toBe(42);
    });

    it("records timing even when the function throws", async () => {
      await expect(
        metrics.time("failing_op", async () => {
          await delay(1);
          throw new Error("boom");
        })
      ).rejects.toThrow("boom");

      expect(metrics.spans["failing_op"]).toBeGreaterThanOrEqual(0);
    });

    it("includes span fields in summarize() with _ms suffix", async () => {
      await metrics.time("kv_read", async () => "cached");
      await metrics.time("github_api", async () => "repos");

      const summary = metrics.summarize();
      expect(summary).toHaveProperty("kv_read_ms");
      expect(summary).toHaveProperty("github_api_ms");
      expect(typeof summary["kv_read_ms"]).toBe("number");
    });
  });

  describe("summarize()", () => {
    it("totals each engine field over the records that report it", () => {
      metrics.sqlQueries.push(
        { query_ms: 100, engine_ms: 10, rows_read: 5, rows_written: 0 },
        { query_ms: 200, engine_ms: 20, rows_read: 15, rows_written: 3 },
        { query_ms: 50 } // first() call: no engine metadata
      );

      expect(metrics.summarize()).toEqual({
        sql_query_count: 3,
        sql_total_ms: 350,
        sql_engine_total_ms: 30,
        sql_rows_read: 20,
        sql_rows_written: 3,
      });
    });

    it("leaves out a field no record reported instead of totalling it to zero", () => {
      metrics.sqlQueries.push(
        { query_ms: 10, engine_ms: 2, rows_written: 1 },
        { query_ms: 20, engine_ms: 4, rows_written: 0 }
      );

      expect(metrics.summarize()).toEqual({
        sql_query_count: 2,
        sql_total_ms: 30,
        sql_engine_total_ms: 6,
        sql_rows_written: 1,
      });
    });
  });
});

describe("instrumentSqlDatabase over an engine that reports every field", () => {
  let fakeDb: FakeDatabase;
  let metrics: RequestMetrics;
  let db: SqlDatabase;

  beforeEach(() => {
    fakeDb = new FakeDatabase();
    metrics = createRequestMetrics();
    db = instrumentSqlDatabase(fakeDb, metrics);
  });

  it("captures timing from run()", async () => {
    await db.prepare("INSERT INTO t VALUES (?)").bind(1).run();

    expect(metrics.sqlQueries).toHaveLength(1);
    expect(metrics.sqlQueries[0].query_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.sqlQueries[0].engine_ms).toBe(5);
    expect(metrics.sqlQueries[0].rows_read).toBe(0);
    expect(metrics.sqlQueries[0].rows_written).toBe(1);
  });

  it("captures timing from all()", async () => {
    await db.prepare("SELECT * FROM t").all();

    expect(metrics.sqlQueries).toHaveLength(1);
    expect(metrics.sqlQueries[0].engine_ms).toBe(8);
    expect(metrics.sqlQueries[0].rows_read).toBe(10);
    expect(metrics.sqlQueries[0].rows_written).toBe(0);
  });

  it("captures timing from first(), which carries no engine metadata", async () => {
    await db.prepare("SELECT * FROM t WHERE id = ?").bind(1).first();

    expect(metrics.sqlQueries).toHaveLength(1);
    expect(metrics.sqlQueries[0].query_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.sqlQueries[0]).not.toHaveProperty("engine_ms");
  });

  it("captures batch() as a single query record with aggregated metadata", async () => {
    const stmts = [
      db.prepare("SELECT * FROM t WHERE id = ?").bind(1),
      db.prepare("SELECT * FROM t WHERE id = ?").bind(2),
      db.prepare("SELECT * FROM t WHERE id = ?").bind(3),
    ];

    await db.batch(stmts);

    expect(metrics.sqlQueries).toHaveLength(1);
    expect(metrics.sqlQueries[0].query_ms).toBeGreaterThanOrEqual(0);
    // 3 statements × 3ms engine time each
    expect(metrics.sqlQueries[0].engine_ms).toBe(9);
    // 3 statements × 5 rows read each
    expect(metrics.sqlQueries[0].rows_read).toBe(15);
    // 3 statements × 2 rows written each
    expect(metrics.sqlQueries[0].rows_written).toBe(6);
  });

  it("batch() hands the engine its own statements, not the instrumented wrappers", async () => {
    const stmts = [
      db.prepare("SELECT * FROM t WHERE id = ?").bind(1),
      db.prepare("SELECT * FROM t WHERE id = ?").bind(2),
    ];

    await db.batch(stmts);

    expect(fakeDb.lastBatchStatements).toHaveLength(2);
    for (const s of fakeDb.lastBatchStatements) {
      expect(s).toBeInstanceOf(FakeStatement);
    }
    expect((fakeDb.lastBatchStatements[1] as FakeStatement).bound).toEqual([2]);
  });

  it("bind() chaining works correctly with instrumented statements", async () => {
    const stmt = db.prepare("SELECT * FROM t WHERE a = ? AND b = ?");
    const bound = stmt.bind(1, 2);
    await bound.all();

    expect(metrics.sqlQueries).toHaveLength(1);
    expect(metrics.sqlQueries[0].engine_ms).toBe(8);
  });

  it("accumulates queries across multiple calls", async () => {
    await db.prepare("SELECT COUNT(*) FROM t").first();
    await db.prepare("SELECT * FROM t").all();
    await db.prepare("INSERT INTO t VALUES (?)").bind(1).run();

    expect(metrics.sqlQueries).toHaveLength(3);

    const summary = metrics.summarize();
    expect(summary.sql_query_count).toBe(3);
    expect(summary.sql_total_ms as number).toBeGreaterThanOrEqual(0);
    // first() has no engine ms, all() has 8, run() has 5
    expect(summary.sql_engine_total_ms).toBe(13);
    expect(summary.sql_rows_read).toBe(10);
    expect(summary.sql_rows_written).toBe(1);
  });

  it("summarize includes both query and span fields", async () => {
    await db.prepare("SELECT * FROM t").all();
    await metrics.time("github_api", async () => "repos");

    const summary = metrics.summarize();
    expect(summary.sql_query_count).toBe(1);
    expect(summary.sql_engine_total_ms).toBe(8);
    expect(summary).toHaveProperty("github_api_ms");
  });
});

// The Node adapter reports duration and rows_written but never rows_read,
// and admits only its own statements to batch(): the two contract edges
// the wrapper has to respect on the host that is not D1.
describe("instrumentSqlDatabase over the Node SQLite adapter", () => {
  let engine: NodeSqlDatabase;
  let metrics: RequestMetrics;
  let db: SqlDatabase;

  beforeEach(() => {
    engine = createNodeSqlDatabase(new DatabaseSync(":memory:"));
    metrics = createRequestMetrics();
    db = instrumentSqlDatabase(engine, metrics);
  });

  afterEach(() => {
    engine.close();
  });

  it("runs an instrumented batch through the engine's same-origin check", async () => {
    await engine.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)").run();

    const results = await db.batch([
      db.prepare("INSERT INTO t (name) VALUES (?)").bind("a"),
      db.prepare("INSERT INTO t (name) VALUES (?)").bind("b"),
      db.prepare("SELECT name FROM t ORDER BY id"),
    ]);

    expect(results.map((r) => r.meta.changes)).toEqual([1, 1, 0]);
    expect(results[2].results).toEqual([{ name: "a" }, { name: "b" }]);
    expect(metrics.sqlQueries).toHaveLength(1);
    expect(metrics.sqlQueries[0].rows_written).toBe(2);
    expect(metrics.sqlQueries[0].engine_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.sqlQueries[0].rows_read).toBeUndefined();
  });

  it("reports only what the engine reports: no rows_read, nothing for first()", async () => {
    await engine.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)").run();

    await db.prepare("INSERT INTO t (name) VALUES (?)").bind("a").run();
    await db.prepare("SELECT name FROM t WHERE id = ?").bind(1).first();

    const summary = metrics.summarize();
    expect(summary.sql_query_count).toBe(2);
    expect(summary.sql_engine_total_ms).toBeGreaterThanOrEqual(0);
    expect(summary.sql_rows_written).toBe(1);
    expect(summary).not.toHaveProperty("sql_rows_read");
  });

  it("emits neither engine field for a request of only first() calls", async () => {
    await engine.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)").run();

    await db.prepare("SELECT COUNT(*) AS n FROM t").first();

    expect(metrics.summarize()).toEqual({
      sql_query_count: 1,
      sql_total_ms: expect.any(Number),
    });
  });
});
