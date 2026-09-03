/**
 * The adapter boundary: every shape of SQL the repositories send must produce
 * the rows and write counts Durable Object storage would.
 */

import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage, type NodeSqlStorage } from "./node-sqlite-storage";

describe("createNodeSqlStorage", () => {
  let db: DatabaseSync;
  let storage: NodeSqlStorage;

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

  it("runs every statement of a parameterless script and counts its writes", () => {
    const result = storage.sql.exec(
      "INSERT INTO t (a) VALUES ('x'); INSERT INTO t (a) VALUES ('y'); CREATE TABLE u (b TEXT);"
    );
    expect(result.rowsWritten).toBe(2);
    expect(storage.sql.exec("SELECT count(*) AS n FROM t").one()).toEqual({ n: 2 });
    expect(storage.sql.exec("SELECT count(*) AS n FROM u").one()).toEqual({ n: 0 });
  });

  it("refuses to bind parameters to a script rather than run only its first statement", () => {
    expect(() =>
      storage.sql.exec("INSERT INTO t (a) VALUES (?); INSERT INTO t (a) VALUES (?)", "x", "y")
    ).toThrow("multi-statement script");
    expect(storage.sql.exec("SELECT count(*) AS n FROM t").one()).toEqual({ n: 0 });
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
        throw new Error("outer failed");
      })
    ).toThrow("outer failed");
    expect(sql.exec("SELECT count(*) AS n FROM t").one()).toEqual({ n: 2 });
  });
});
