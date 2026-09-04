/**
 * The adapter boundary: every shape of SQL the repositories send must produce
 * the rows and write counts Durable Object storage would.
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionStorage } from "../session/platform";
import { createNodeSqlStorage } from "./sqlite-storage";

const GC_REGRESSION_CHILD = "OPEN_INSPECT_NODE_SQLITE_GC_REGRESSION";
const isGcRegressionChild = process.env[GC_REGRESSION_CHILD] === "1";

describe("createNodeSqlStorage", () => {
  let db: DatabaseSync;
  let storage: SessionStorage;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    storage = createNodeSqlStorage(db);
    storage.sql.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT)");
  });

  afterEach(() => {
    db.close();
  });

  it("returns rows and no writes for a read", () => {
    storage.sql.exec("INSERT INTO t (a) VALUES (?)", "x");
    const result = storage.sql.exec("SELECT a FROM t WHERE a = ?", "x");
    expect(result.toArray()).toEqual([{ a: "x" }]);
    expect(result.one()).toEqual({ a: "x" });
    expect(result.rowsRead).toBe(1);
    expect(result.rowsWritten).toBe(0);
  });

  it("throws from one() unless the result is exactly one row, as Durable Object cursors do", () => {
    expect(() => storage.sql.exec("SELECT a FROM t").one()).toThrow("got 0");
    storage.sql.exec("INSERT INTO t (a) VALUES (?), (?)", "x", "y");
    expect(storage.sql.exec("SELECT a FROM t WHERE a = ?", "x").one()).toEqual({ a: "x" });
    expect(() => storage.sql.exec("SELECT a FROM t").one()).toThrow("got 2");
    expect(() => storage.sql.exec("DELETE FROM t; DELETE FROM t;").one()).toThrow("got 0");
  });

  it("counts the rows a write changed", () => {
    storage.sql.exec("INSERT INTO t (a) VALUES (?), (?)", "x", "y");
    const result = storage.sql.exec("UPDATE t SET a = 'z'");
    expect(result.toArray()).toEqual([]);
    expect(result.rowsWritten).toBe(2);
    expect(storage.sql.exec("DELETE FROM t WHERE a = ?", "missing").rowsWritten).toBe(0);
  });

  it("returns the rows of a RETURNING write and counts it", () => {
    const result = storage.sql.exec("INSERT INTO t (a) VALUES (?) RETURNING id, a", "x");
    expect(result.toArray()).toEqual([{ id: 1, a: "x" }]);
    expect(result.rowsWritten).toBe(1);
  });

  it("is not confused by comments before the statement", () => {
    storage.sql.exec("INSERT INTO t (a) VALUES (?)", "x");
    expect(storage.sql.exec("/* read */ -- still a read\nSELECT a FROM t").toArray()).toEqual([
      { a: "x" },
    ]);
    expect(storage.sql.exec("/* write */ DELETE FROM t").rowsWritten).toBe(1);
  });

  it("treats a CTE write as a single counted statement", () => {
    storage.sql.exec("INSERT INTO t (a) VALUES (?), (?)", "x", "y");
    const result = storage.sql.exec(
      "WITH doomed AS (SELECT id FROM t WHERE a = ?) DELETE FROM t WHERE id IN (SELECT id FROM doomed)",
      "x"
    );
    expect(result.rowsWritten).toBe(1);
    expect(storage.sql.exec("SELECT a FROM t").toArray()).toEqual([{ a: "y" }]);
  });

  it("keeps semicolons and keywords inside literals from turning a statement into a script", () => {
    const result = storage.sql.exec("INSERT INTO t (a) VALUES (?)", "a; b RETURNING SELECT");
    expect(result.rowsWritten).toBe(1);
    expect(storage.sql.exec("INSERT INTO t (a) VALUES ('c; d')").rowsWritten).toBe(1);
    expect(storage.sql.exec("SELECT a FROM t ORDER BY id").toArray()).toEqual([
      { a: "a; b RETURNING SELECT" },
      { a: "c; d" },
    ]);
  });

  it("runs every statement of a script and reports only the last one's rows and writes", () => {
    const result = storage.sql.exec(
      "INSERT INTO t (a) VALUES ('x'); INSERT INTO t (a) VALUES ('y'); CREATE TABLE u (b TEXT); SELECT a FROM t ORDER BY id"
    );
    expect(result.toArray()).toEqual([{ a: "x" }, { a: "y" }]);
    // The earlier inserts are not in the count: a Durable Object cursor
    // reports the last statement only.
    expect(result.rowsWritten).toBe(0);
    expect(storage.sql.exec("SELECT count(*) AS n FROM u").one()).toEqual({ n: 0 });
    const returning = storage.sql.exec(
      "DELETE FROM t WHERE a = 'x'; INSERT INTO t (a) VALUES ('z') RETURNING a"
    );
    expect(returning.one()).toEqual({ a: "z" });
    expect(returning.rowsWritten).toBe(1);
  });

  it("binds parameters to the last statement of a script only, as a Durable Object does", () => {
    const result = storage.sql.exec(
      "INSERT INTO t (a) VALUES ('x'); SELECT a FROM t WHERE a = ?",
      "x"
    );
    expect(result.one()).toEqual({ a: "x" });
    expect(() =>
      storage.sql.exec("INSERT INTO t (a) VALUES (?); SELECT count(*) AS n FROM t", "y")
    ).toThrow("only the last statement can have parameters");
    expect(() => storage.sql.exec("INSERT INTO t (a) VALUES (?); SELECT 1")).toThrow(
      "only the last statement can have parameters"
    );
    expect(() =>
      storage.sql.exec(
        "INSERT INTO t (a) VALUES ('must not persist'); INSERT INTO t (a) VALUES (?); SELECT 1"
      )
    ).toThrow("only the last statement can have parameters");
    expect(storage.sql.exec("SELECT count(*) AS n FROM t").one()).toEqual({ n: 1 });
  });

  it("survives garbage collection and close after statement-less SQL tails", () => {
    if (isGcRegressionChild) return;
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const vitestRoot = dirname(dirname(fileURLToPath(import.meta.resolve("vitest"))));
    const child = spawnSync(
      process.execPath,
      ["--expose-gc", "--no-warnings", join(vitestRoot, "vitest.mjs"), "run", import.meta.filename],
      {
        cwd: packageRoot,
        encoding: "utf8",
        env: { ...process.env, [GC_REGRESSION_CHILD]: "1" },
        timeout: 30_000,
      }
    );

    expect(
      { status: child.status, signal: child.signal, stdout: child.stdout, stderr: child.stderr },
      "the isolated node:sqlite lifecycle probe must exit normally"
    ).toMatchObject({ status: 0, signal: null });
  });

  it("rejects a trailing comment or empty statement after a statement, as a Durable Object does", () => {
    storage.sql.exec("INSERT INTO t (a) VALUES (?);", "x");
    for (const query of [
      "SELECT a FROM t; -- trailing line comment",
      "SELECT a FROM t; /* trailing block */",
      "SELECT a FROM t; /* unterminated block comment",
      "SELECT a FROM t;;",
      "SELECT a FROM t;\0SELECT 1",
      "UPDATE t SET a = 'y'; -- done",
    ]) {
      expect(() => storage.sql.exec(query)).toThrow("did not contain a statement");
    }
    expect(() => storage.sql.exec("SELECT a FROM t WHERE a = ?; -- note", "x")).toThrow(
      "did not contain a statement"
    );
    // Whitespace after the last statement, and comments before or between
    // statements, are fine on both hosts.
    expect(storage.sql.exec("SELECT a FROM t;\t\f\r\n\ufeff").toArray()).toEqual([{ a: "x" }]);
    expect(storage.sql.exec("SELECT 1; -- between\nSELECT a FROM t -- end").toArray()).toEqual([
      { a: "x" },
    ]);
  });

  it("rejects text that holds no statement", () => {
    expect(() => storage.sql.exec("-- nothing here")).toThrow("did not contain a statement");
    expect(() => storage.sql.exec("\ufeff")).toThrow("did not contain a statement");
    expect(() => storage.sql.exec("; -- still nothing\n /* nothing */ ;")).toThrow(
      "did not contain a statement"
    );
    expect(() => storage.sql.exec("   ")).toThrow("did not contain a statement");
    expect(() => storage.sql.exec("")).toThrow("did not contain a statement");
  });

  it("enforces foreign keys, as Durable Object storage does", () => {
    storage.sql.exec("CREATE TABLE child (parent INTEGER REFERENCES t(id))");
    expect(() => storage.sql.exec("INSERT INTO child (parent) VALUES (?)", 99)).toThrow(
      "FOREIGN KEY"
    );
  });

  it("rolls back every write of a throwing closure and leaves the connection usable", () => {
    const { sql, transactionSync } = storage;
    expect(() =>
      transactionSync(() => {
        sql.exec("INSERT INTO t (a) VALUES ('lost')");
        sql.exec("UPDATE t SET a = 'also lost'");
        throw new Error("closure failed");
      })
    ).toThrow("closure failed");
    expect(sql.exec("SELECT count(*) AS n FROM t").one()).toEqual({ n: 0 });
    expect(transactionSync(() => sql.exec("INSERT INTO t (a) VALUES ('kept')").rowsWritten)).toBe(
      1
    );
    expect(sql.exec("SELECT a FROM t").toArray()).toEqual([{ a: "kept" }]);
  });

  it("commits nested transactions together and rolls back the failing scope only", () => {
    const { sql, transactionSync } = storage;
    transactionSync(() => {
      sql.exec("INSERT INTO t (a) VALUES ('outer')");
      expect(() =>
        transactionSync(() => {
          sql.exec("INSERT INTO t (a) VALUES ('inner')");
          throw new Error("inner failed");
        })
      ).toThrow("inner failed");
      transactionSync(() => sql.exec("INSERT INTO t (a) VALUES ('inner-2')"));
    });
    expect(sql.exec("SELECT a FROM t ORDER BY id").toArray()).toEqual([
      { a: "outer" },
      { a: "inner-2" },
    ]);

    expect(() =>
      transactionSync(() => {
        sql.exec("INSERT INTO t (a) VALUES ('lost')");
        transactionSync(() => sql.exec("INSERT INTO t (a) VALUES ('nested but lost')"));
        throw new Error("outer failed");
      })
    ).toThrow("outer failed");
    expect(sql.exec("SELECT count(*) AS n FROM t").one()).toEqual({ n: 2 });
  });
});

if (isGcRegressionChild) {
  describe("node:sqlite statement finalization regression", () => {
    it("does not retain dangling statements after statement-less tails", async () => {
      const directory = mkdtempSync(join(tmpdir(), "node-sqlite-gc-"));
      const db = new DatabaseSync(join(directory, "probe.db"));
      const storage = createNodeSqlStorage(db);

      try {
        for (let index = 0; index < 50; index += 1) {
          storage.sql.exec("SELECT 1;\n");
          expect(() => storage.sql.exec("SELECT 1; -- trailing comment")).toThrow(
            "did not contain a statement"
          );
          expect(() => storage.sql.exec("SELECT 1;;")).toThrow("did not contain a statement");
          expect(() => storage.sql.exec("SELECT 1;\0SELECT 2")).toThrow(
            "did not contain a statement"
          );
        }
        for (let attempt = 0; attempt < 3; attempt += 1) {
          (globalThis as { gc?: () => void }).gc?.();
          await new Promise<void>((resolveNow) => setImmediate(resolveNow));
        }
        db.close();
      } finally {
        try {
          db.close();
        } catch {
          // already closed
        }
        rmSync(directory, { recursive: true, force: true });
      }
    });
  });
}
