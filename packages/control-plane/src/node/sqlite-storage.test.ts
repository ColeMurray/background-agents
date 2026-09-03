/**
 * The adapter boundary: every shape of SQL the repositories send must produce
 * the rows and write counts Durable Object storage would.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionStorage } from "../session/platform";
import { createNodeSqlStorage } from "./sqlite-storage";

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
    expect(storage.sql.exec("SELECT count(*) AS n FROM t").one()).toEqual({ n: 1 });
  });

  it("rejects a trailing comment or empty statement after a statement, as a Durable Object does", () => {
    storage.sql.exec("INSERT INTO t (a) VALUES (?);", "x");
    for (const query of [
      "SELECT a FROM t; -- trailing line comment",
      "SELECT a FROM t; /* trailing block */",
      "SELECT a FROM t;;",
      "UPDATE t SET a = 'y'; -- done",
    ]) {
      expect(() => storage.sql.exec(query)).toThrow("did not contain a statement");
    }
    expect(() => storage.sql.exec("SELECT a FROM t WHERE a = ?; -- note", "x")).toThrow(
      "did not contain a statement"
    );
    // Whitespace after the last statement, and comments before or between
    // statements, are fine on both hosts.
    expect(storage.sql.exec("SELECT a FROM t;\n  \n").toArray()).toEqual([{ a: "x" }]);
    expect(storage.sql.exec("SELECT 1; -- between\nSELECT a FROM t -- end").toArray()).toEqual([
      { a: "x" },
    ]);
  });

  it("rejects text that holds no statement", () => {
    expect(() => storage.sql.exec("-- nothing here")).toThrow("did not contain a statement");
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
