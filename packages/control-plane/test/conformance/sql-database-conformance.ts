/**
 * The `SqlDatabase` contract, run against every engine that implements the
 * port: D1 in the workerd lane (test/integration/sql-database-conformance.test.ts)
 * and `node:sqlite` in the Node lane (sql-database-conformance.node.test.ts).
 * Each case pins a semantic the stores rely on; an engine that fails one
 * would make a store misbehave silently.
 */

import { describe, expect, it } from "vitest";
import { isUniqueConstraintError } from "../../src/db/errors";
import type { SqlDatabase, SqlStatement } from "../../src/db/sql-database";

/** Runs one assertion against an engine; the callback owns the connection's lifetime. */
export type SqlDatabaseFactory = <T>(run: (db: SqlDatabase) => Promise<T>) => Promise<T>;

const TABLE = "sql_conformance_rows";

export function registerSqlDatabaseConformanceSuite(factory: SqlDatabaseFactory): void {
  const withTable = <T>(run: (db: SqlDatabase) => Promise<T>): Promise<T> =>
    factory(async (db) => {
      await db
        .prepare(
          `CREATE TABLE IF NOT EXISTS ${TABLE} (id INTEGER PRIMARY KEY, k TEXT UNIQUE, v INTEGER)`
        )
        .run();
      await db.prepare(`DELETE FROM ${TABLE}`).run();
      try {
        return await run(db);
      } finally {
        await db.prepare(`DROP TABLE IF EXISTS ${TABLE}`).run();
      }
    });

  /** A stored binary value as bytes, however the engine returns it. */
  const bytesOf = (value: unknown): number[] => {
    if (Array.isArray(value)) return value as number[];
    if (value instanceof ArrayBuffer) return [...new Uint8Array(value)];
    if (ArrayBuffer.isView(value)) {
      return [...new Uint8Array(value.buffer, value.byteOffset, value.byteLength)];
    }
    throw new Error(`Not a binary value: ${String(value)}`);
  };

  const count = async (db: SqlDatabase): Promise<number> => {
    const row = await db.prepare(`SELECT count(*) AS n FROM ${TABLE}`).first<{ n: number }>();
    return row!.n;
  };

  describe("SqlDatabase conformance", () => {
    it("first() is null when no row matches and the row otherwise", async () => {
      await withTable(async (db) => {
        expect(await db.prepare(`SELECT k FROM ${TABLE} WHERE k = ?`).bind("a").first()).toBeNull();
        await db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES (?, ?)`).bind("a", 1).run();
        expect(await db.prepare(`SELECT k, v FROM ${TABLE} WHERE k = ?`).bind("a").first()).toEqual(
          { k: "a", v: 1 }
        );
      });
    });

    it("bind() returns an independent statement each time", async () => {
      await withTable(async (db) => {
        await db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('a', 1), ('b', 2)`).run();
        const select = db.prepare(`SELECT v FROM ${TABLE} WHERE k = ?`);
        const forA = select.bind("a");
        const forB = select.bind("b");
        expect(await forA.first()).toEqual({ v: 1 });
        expect(await forB.first()).toEqual({ v: 2 });
        expect(await forA.first()).toEqual({ v: 1 });
      });
    });

    it("reports the rows a statement wrote in meta.changes, and zero for a read", async () => {
      await withTable(async (db) => {
        const inserted = await db
          .prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('a', 1), ('b', 2), ('c', 3)`)
          .run();
        expect(inserted.meta.changes).toBe(3);
        const updated = await db
          .prepare(`UPDATE ${TABLE} SET v = v + 10 WHERE v > ?`)
          .bind(1)
          .run();
        expect(updated.meta.changes).toBe(2);
        const missed = await db.prepare(`UPDATE ${TABLE} SET v = 0 WHERE k = ?`).bind("zz").run();
        expect(missed.meta.changes).toBe(0);
        const read = await db.prepare(`SELECT k FROM ${TABLE} ORDER BY k`).all<{ k: string }>();
        expect(read.meta.changes).toBe(0);
        expect(read.results).toEqual([{ k: "a" }, { k: "b" }, { k: "c" }]);
        const deleted = await db.prepare(`DELETE FROM ${TABLE}`).run();
        expect(deleted.meta.changes).toBe(3);
      });
    });

    it("binds booleans as integers and refuses undefined at bind time", async () => {
      await withTable(async (db) => {
        await db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES (?, ?)`).bind("flag", true).run();
        expect(await db.prepare(`SELECT v FROM ${TABLE} WHERE k = 'flag'`).first()).toEqual({
          v: 1,
        });
        expect(() => db.prepare(`SELECT ?`).bind(undefined)).toThrow();
      });
    });

    it("refuses a bigint, which not every engine can bind", async () => {
      await withTable(async (db) => {
        // Refused at bind or at execution, whichever the engine does; the
        // portable rule is that it never runs.
        await expect(
          Promise.resolve().then(() =>
            db
              .prepare(`INSERT INTO ${TABLE} (k, v) VALUES (?, ?)`)
              .bind("big", 2n ** 40n)
              .run()
          )
        ).rejects.toThrow();
        expect(await count(db)).toBe(0);
      });
    });

    it("snapshots a bound binary value at bind time", async () => {
      await withTable(async (db) => {
        const bytes = new Uint8Array([1, 2, 3]);
        const insert = db
          .prepare(`INSERT INTO ${TABLE} (k, v) VALUES (?, ?)`)
          .bind("blob", bytes.buffer);
        bytes[0] = 9;
        await insert.run();
        const row = await db
          .prepare(`SELECT v FROM ${TABLE} WHERE k = 'blob'`)
          .first<{ v: unknown }>();
        expect(bytesOf(row!.v)).toEqual([1, 2, 3]);
      });
    });

    it("batch() applies every statement or none", async () => {
      await withTable(async (db) => {
        await expect(
          db.batch([
            db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('a', 1)`),
            db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('b', 2)`),
            // Violates the unique key: the whole batch must roll back.
            db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('a', 3)`),
          ])
        ).rejects.toThrow();
        expect(await count(db)).toBe(0);
      });
    });

    it("keeps a write issued while a batch is in flight outside the batch", async () => {
      await withTable(async (db) => {
        // Not awaited before the unrelated write: the batch must not leave
        // its transaction open across a turn for the write to land inside.
        const failing = db.batch([
          db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('a', 1)`),
          db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('a', 2)`),
        ]);
        const unrelated = db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('z', 26)`).run();
        await expect(failing).rejects.toThrow();
        await unrelated;
        const rows = await db.prepare(`SELECT k FROM ${TABLE}`).all<{ k: string }>();
        expect(rows.results).toEqual([{ k: "z" }]);
      });
    });

    it("batch() returns results positionally, each statement seeing the earlier ones", async () => {
      await withTable(async (db) => {
        const [inserted, seen, updated, after] = await db.batch<{ n?: number; v?: number }>([
          db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('a', 1)`),
          db.prepare(`SELECT count(*) AS n FROM ${TABLE}`),
          db.prepare(`UPDATE ${TABLE} SET v = ? WHERE k = ?`).bind(5, "a"),
          db.prepare(`SELECT v FROM ${TABLE} WHERE k = 'a'`),
        ]);
        expect(inserted!.meta.changes).toBe(1);
        expect(seen!.results).toEqual([{ n: 1 }]);
        expect(updated!.meta.changes).toBe(1);
        expect(after!.results).toEqual([{ v: 5 }]);
      });
    });

    it("batch() refuses a statement this database did not prepare", async () => {
      await withTable(async (db) => {
        const foreign: SqlStatement = {
          bind: () => foreign,
          first: async () => null,
          run: async () => ({ results: [], meta: { changes: 0 } }),
          all: async () => ({ results: [], meta: { changes: 0 } }),
        };
        await expect(
          db.batch([db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('a', 1)`), foreign])
        ).rejects.toThrow();
        expect(await count(db)).toBe(0);
      });
    });

    it("surfaces a unique violation as a unique constraint error", async () => {
      await withTable(async (db) => {
        const insert = db.prepare(`INSERT INTO ${TABLE} (k, v) VALUES ('a', 1)`);
        await insert.run();
        const failure = await insert.run().then(
          () => null,
          (error: unknown) => error
        );
        expect(failure).not.toBeNull();
        expect(isUniqueConstraintError(failure)).toBe(true);
      });
    });
  });
}
