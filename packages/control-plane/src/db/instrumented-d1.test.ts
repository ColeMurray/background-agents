import { beforeEach, describe, expect, it } from "vitest";
import { createRequestMetrics, instrumentD1 } from "./instrumented-d1";
import type { RequestMetrics } from "./instrumented-d1";

// ---------------------------------------------------------------------------
// Fake D1 implementation for testing the instrumented wrapper
// ---------------------------------------------------------------------------

class FakeD1PreparedStatement {
  private bound: unknown[] = [];

  constructor(private query: string) {}

  bind(...args: unknown[]) {
    const stmt = new FakeD1PreparedStatement(this.query);
    stmt.bound = args;
    return stmt;
  }

  async first<T>(_colName?: string): Promise<T | null> {
    // Simulate D1 latency
    await delay(1);
    return { id: 1, name: "test" } as T;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    await delay(1);
    return {
      results: [],
      success: true,
      meta: { duration: 5, rows_read: 0, rows_written: 1 },
    } as unknown as D1Result<T>;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    await delay(1);
    return {
      results: [{ id: 1 }, { id: 2 }] as T[],
      success: true,
      meta: { duration: 8, rows_read: 10, rows_written: 0 },
    } as unknown as D1Result<T>;
  }

  async raw<T = unknown[]>(_options?: { columnNames?: boolean }): Promise<T[]> {
    await delay(1);
    return [[1, "test"]] as T[];
  }
}

class FakeD1Database {
  /** Statements received by the last batch() call (for assertion). */
  lastBatchStatements: D1PreparedStatement[] = [];

  prepare(query: string) {
    return new FakeD1PreparedStatement(query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    this.lastBatchStatements = statements;
    await delay(1);
    return statements.map(() => ({
      results: [{ id: 1 }] as T[],
      success: true,
      meta: { duration: 3, rows_read: 5, rows_written: 2 },
    })) as unknown as D1Result<T>[];
  }

  async exec(_query: string): Promise<D1ExecResult> {
    return { count: 0, duration: 0 };
  }

  async dump(): Promise<ArrayBuffer> {
    return new ArrayBuffer(0);
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
    expect(metrics.d1Queries).toEqual([]);
    expect(metrics.spans).toEqual({});
  });

  it("summarize() returns zeros when no queries recorded", () => {
    const summary = metrics.summarize();
    expect(summary).toEqual({
      d1_query_count: 0,
      d1_total_ms: 0,
      d1_server_total_ms: 0,
      d1_rows_read: 0,
      d1_rows_written: 0,
    });
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
    it("computes correct totals from multiple query records", () => {
      metrics.d1Queries.push(
        { query_ms: 100, d1_server_ms: 10, rows_read: 5, rows_written: 0 },
        { query_ms: 200, d1_server_ms: 20, rows_read: 15, rows_written: 3 },
        { query_ms: 50 } // first() call — no server metadata
      );

      const summary = metrics.summarize();
      expect(summary).toEqual({
        d1_query_count: 3,
        d1_total_ms: 350,
        d1_server_total_ms: 30,
        d1_rows_read: 20,
        d1_rows_written: 3,
      });
    });
  });
});

describe("instrumentD1", () => {
  let fakeDb: FakeD1Database;
  let metrics: RequestMetrics;
  let db: D1Database;

  beforeEach(() => {
    fakeDb = new FakeD1Database();
    metrics = createRequestMetrics();
    db = instrumentD1(fakeDb as unknown as D1Database, metrics);
  });

  it("captures timing from run()", async () => {
    await db.prepare("INSERT INTO t VALUES (?)").bind(1).run();

    expect(metrics.d1Queries).toHaveLength(1);
    expect(metrics.d1Queries[0].query_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.d1Queries[0].d1_server_ms).toBe(5);
    expect(metrics.d1Queries[0].rows_read).toBe(0);
    expect(metrics.d1Queries[0].rows_written).toBe(1);
  });

  it("captures timing from all()", async () => {
    await db.prepare("SELECT * FROM t").all();

    expect(metrics.d1Queries).toHaveLength(1);
    expect(metrics.d1Queries[0].d1_server_ms).toBe(8);
    expect(metrics.d1Queries[0].rows_read).toBe(10);
    expect(metrics.d1Queries[0].rows_written).toBe(0);
  });

  it("captures timing from first()", async () => {
    await db.prepare("SELECT * FROM t WHERE id = ?").bind(1).first();

    expect(metrics.d1Queries).toHaveLength(1);
    expect(metrics.d1Queries[0].query_ms).toBeGreaterThanOrEqual(0);
    // first() does not return D1Meta
    expect(metrics.d1Queries[0].d1_server_ms).toBeUndefined();
  });

  it("captures timing from raw()", async () => {
    await db.prepare("SELECT id, name FROM t").raw();

    expect(metrics.d1Queries).toHaveLength(1);
    expect(metrics.d1Queries[0].query_ms).toBeGreaterThanOrEqual(0);
    expect(metrics.d1Queries[0].d1_server_ms).toBeUndefined();
  });

  it("captures batch() as a single query record with aggregated metadata", async () => {
    const stmts = [
      db.prepare("SELECT * FROM t WHERE id = ?").bind(1),
      db.prepare("SELECT * FROM t WHERE id = ?").bind(2),
      db.prepare("SELECT * FROM t WHERE id = ?").bind(3),
    ];

    await db.batch(stmts);

    expect(metrics.d1Queries).toHaveLength(1);
    expect(metrics.d1Queries[0].query_ms).toBeGreaterThanOrEqual(0);
    // 3 statements × 3ms server time each = 9ms aggregated
    expect(metrics.d1Queries[0].d1_server_ms).toBe(9);
    // 3 statements × 5 rows read each = 15 aggregated
    expect(metrics.d1Queries[0].rows_read).toBe(15);
    // 3 statements × 2 rows written each = 6 aggregated
    expect(metrics.d1Queries[0].rows_written).toBe(6);
  });

  it("batch() unwraps instrumented statements before passing to real D1", async () => {
    const stmts = [
      db.prepare("SELECT * FROM t WHERE id = ?").bind(1),
      db.prepare("SELECT * FROM t WHERE id = ?").bind(2),
    ];

    await db.batch(stmts);

    // The real D1 should receive FakeD1PreparedStatement instances,
    // not plain-object instrumented wrappers.
    for (const s of fakeDb.lastBatchStatements) {
      expect(s).toBeInstanceOf(FakeD1PreparedStatement);
    }
  });

  it("bind() chaining works correctly with instrumented statements", async () => {
    const stmt = db.prepare("SELECT * FROM t WHERE a = ? AND b = ?");
    const bound = stmt.bind(1, 2);
    await bound.all();

    expect(metrics.d1Queries).toHaveLength(1);
    expect(metrics.d1Queries[0].d1_server_ms).toBe(8);
  });

  it("accumulates queries across multiple calls", async () => {
    await db.prepare("SELECT COUNT(*) FROM t").first();
    await db.prepare("SELECT * FROM t").all();
    await db.prepare("INSERT INTO t VALUES (?)").bind(1).run();

    expect(metrics.d1Queries).toHaveLength(3);

    const summary = metrics.summarize();
    expect(summary.d1_query_count).toBe(3);
    expect(summary.d1_total_ms as number).toBeGreaterThanOrEqual(0);
    // first() has no server ms, all() has 8, run() has 5
    expect(summary.d1_server_total_ms).toBe(13);
    expect(summary.d1_rows_read).toBe(10);
    expect(summary.d1_rows_written).toBe(1);
  });

  it("passes through exec() to the underlying database", async () => {
    const result = await db.exec("CREATE TABLE t (id INT)");
    expect(result).toEqual({ count: 0, duration: 0 });
  });

  it("passes through dump() to the underlying database", async () => {
    const result = await db.dump();
    expect(result).toBeInstanceOf(ArrayBuffer);
  });

  it("summarize includes both D1 and span fields", async () => {
    await db.prepare("SELECT * FROM t").all();
    await metrics.time("github_api", async () => "repos");

    const summary = metrics.summarize();
    expect(summary.d1_query_count).toBe(1);
    expect(summary.d1_server_total_ms).toBe(8);
    expect(summary).toHaveProperty("github_api_ms");
  });
});
