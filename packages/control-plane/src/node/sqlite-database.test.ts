import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNodeSqlDatabase,
  openNodeSqlDatabase,
  type NodeSqlDatabase,
} from "./sqlite-database";
import { BUSY_TIMEOUT_MS } from "./sqlite-file";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

describe("createNodeSqlDatabase", () => {
  let db: NodeSqlDatabase;

  beforeEach(async () => {
    db = createNodeSqlDatabase(new DatabaseSync(":memory:"));
    await db.prepare("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b BLOB, n INTEGER)").run();
  });

  afterEach(() => {
    db.close();
  });

  it("takes exactly one statement per prepare(), as D1 does", async () => {
    // Like D1, the text is compiled when the statement runs, not at prepare().
    await expect(db.prepare("INSERT INTO t (a) VALUES ('x'); DELETE FROM t").run()).rejects.toThrow(
      "exactly one SQL statement"
    );
    expect(await db.prepare("SELECT count(*) AS n FROM t").first()).toEqual({ n: 0 });
    await expect(db.prepare("-- nothing here").all()).rejects.toThrow(
      "did not contain a statement"
    );
    // Trailing whitespace and comments after the one statement are fine.
    expect(await db.prepare("SELECT 1 AS one; -- done\n").first()).toEqual({ one: 1 });
  });

  it("binds buffers and views as blobs, converts booleans, and names what it cannot bind", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await db
      .prepare("INSERT INTO t (a, b, n) VALUES (?, ?, ?)")
      .bind("buffer", bytes.buffer, 1)
      .run();
    await db.prepare("INSERT INTO t (a, b, n) VALUES (?, ?, ?)").bind("view", bytes, false).run();
    const rows = await db.prepare("SELECT a, b, n FROM t ORDER BY id").all<{
      a: string;
      b: Uint8Array;
      n: number;
    }>();
    expect(rows.results.map((r) => [r.a, [...r.b], r.n])).toEqual([
      ["buffer", [1, 2, 3], 1],
      ["view", [1, 2, 3], 0],
    ]);
    expect(() => db.prepare("SELECT ?").bind(new Date())).toThrow(
      "Cannot bind a value of type Date"
    );
    expect(() => db.prepare("SELECT ?").bind({})).toThrow("Cannot bind a value of type Object");
    expect(() => db.prepare("SELECT ?").bind(2n ** 40n)).toThrow(
      "Cannot bind a value of type bigint"
    );
  });

  it("rolls a batch back and leaves the connection usable", async () => {
    await expect(
      db.batch([
        db.prepare("INSERT INTO t (a) VALUES ('kept?')"),
        db.prepare("INSERT INTO no_such_table (a) VALUES ('boom')"),
      ])
    ).rejects.toThrow("no such table");
    expect(await db.prepare("SELECT count(*) AS n FROM t").first()).toEqual({ n: 0 });
    await db.prepare("INSERT INTO t (a) VALUES ('after')").run();
    expect(await db.prepare("SELECT count(*) AS n FROM t").first()).toEqual({ n: 1 });
  });

  it("returns RETURNING rows from run() with the write counted", async () => {
    const result = await db.prepare("INSERT INTO t (a) VALUES ('x') RETURNING id, a").run();
    expect(result.results).toEqual([{ id: 1, a: "x" }]);
    expect(result.meta.changes).toBe(1);
    expect(result.meta.rows_written).toBe(1);
    expect(typeof result.meta.duration).toBe("number");
  });
});

describe("openNodeSqlDatabase", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), "node-sql-database-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("opens a private WAL-mode file with a busy timeout and foreign keys enforced", async () => {
    const path = join(dataDir, "global.db");
    const db = openNodeSqlDatabase(path);
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(await db.prepare("PRAGMA journal_mode").first()).toEqual({ journal_mode: "wal" });
      expect(await db.prepare("PRAGMA busy_timeout").first()).toEqual({ timeout: BUSY_TIMEOUT_MS });
      expect(await db.prepare("PRAGMA foreign_keys").first()).toEqual({ foreign_keys: 1 });
    } finally {
      db.close();
    }
  });

  it("applies the repository's migrations when given the directory", async () => {
    const db = openNodeSqlDatabase(join(dataDir, "global.db"), { migrationsDir: MIGRATIONS_DIR });
    try {
      const sessions = await db
        .prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'sessions'")
        .first();
      expect(sessions).toEqual({ n: 1 });
    } finally {
      db.close();
    }
  });
});
