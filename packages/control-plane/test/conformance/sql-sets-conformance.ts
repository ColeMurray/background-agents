import { describe, expect, it } from "vitest";
import { bulkInsertStatements } from "../../src/db/bulk-insert";
import { idListBatches } from "../../src/db/id-list";
import { MAX_SQLITE_JSON_BYTES } from "../../src/db/sqlite-sets";
import type { SqlDatabase } from "../../src/db/sql-database";
import type { SqlDatabaseFactory } from "./sql-database-conformance";

/** Execute real SQL through both adapters, including the request metrics wrapper. */
export function registerSqlSetsConformanceSuite(factory: SqlDatabaseFactory) {
  const withTable = <T>(run: (db: SqlDatabase) => Promise<T>) =>
    factory(async (db) => {
      await db
        .prepare("CREATE TABLE set_rows (id INTEGER PRIMARY KEY, label TEXT UNIQUE, value INTEGER)")
        .run();
      try {
        return await run(db);
      } finally {
        await db.prepare("DROP TABLE set_rows").run();
      }
    });

  describe("SQL set operations", () => {
    it("inserts 101 rows with one parameter and preserves keyed columns and scalar types", async () => {
      await withTable(async (db) => {
        const rows = Array.from({ length: 101 }, (_, id) =>
          id % 2
            ? { label: `quote'"雪-${id}`, value: id, id }
            : { id, value: id, label: `quote'"雪-${id}` }
        );
        rows[0].label = '[{"type":"global"}]';
        const statements = bulkInsertStatements(db, "set_rows", rows);
        expect(statements).toHaveLength(1);
        const [result] = await db.batch(statements);
        expect(result.meta.changes).toBe(101);
        expect(
          (await db.prepare("SELECT id, label, value FROM set_rows ORDER BY id").all()).results
        ).toEqual(rows);
        await db.batch(
          bulkInsertStatements(db, "set_rows", [{ id: 102, label: null, value: true }])
        );
        expect(
          await db.prepare("SELECT label, value FROM set_rows WHERE id = 102").first()
        ).toEqual({ label: null, value: 1 });
      });
    });

    it.each([
      1_000_000_000_000_000_100,
      -1_000_000_000_000_000_100,
      Number.MAX_SAFE_INTEGER + 1,
      0.125,
    ])("preserves direct numeric binding for %s", async (value) => {
      await withTable(async (db) => {
        await db.prepare("INSERT INTO set_rows VALUES (?, ?, ?)").bind(1, "direct", value).run();
        await db.batch(bulkInsertStatements(db, "set_rows", [{ id: 2, label: "bulk", value }]));
        // Inspect SQL text rather than converting the stored integer back to
        // a JS number, which would round away the difference being tested.
        const rows = await db
          .prepare(
            "SELECT typeof(value) AS type, CAST(value AS TEXT) AS value FROM set_rows ORDER BY id"
          )
          .all();
        expect(rows.results).toHaveLength(2);
        expect(rows.results[1]).toEqual(rows.results[0]);
      });
    });

    it("hydrates 101 identifiers with one parameterized set and accepts an empty set", async () => {
      await withTable(async (db) => {
        const labels = Array.from({ length: 101 }, (_, id) => `literal'"雪-${id}`);
        await db.batch(
          bulkInsertStatements(
            db,
            "set_rows",
            labels.map((label, id) => ({ id, label, value: id }))
          )
        );
        const lists = idListBatches(db, labels);
        expect(lists).toHaveLength(1);
        expect(lists[0].values).toHaveLength(1);
        const result = await db
          .prepare(`SELECT label FROM set_rows WHERE label IN (${lists[0].sql}) ORDER BY id`)
          .bind(...lists[0].values)
          .all<{ label: string }>();
        expect(result.results.map(({ label }) => label)).toEqual(labels);
        expect(idListBatches(db, [])).toEqual([]);
        expect(bulkInsertStatements(db, "set_rows", [])).toEqual([]);
      });
    });

    it("directly binds an identifier whose JSON escaping exceeds the byte limit", async () => {
      await withTable(async (db) => {
        const escapedId = "\\".repeat(999_999);
        expect(new TextEncoder().encode(escapedId).byteLength).toBeLessThan(MAX_SQLITE_JSON_BYTES);
        expect(new TextEncoder().encode(JSON.stringify([escapedId])).byteLength).toBeGreaterThan(
          MAX_SQLITE_JSON_BYTES
        );
        await db.batch([
          db.prepare("INSERT INTO set_rows VALUES (?, ?, ?)").bind(1, "ordinary", 1),
          db.prepare("INSERT INTO set_rows VALUES (?, ?, ?)").bind(2, escapedId, 2),
        ]);
        const lists = idListBatches(db, ["ordinary", escapedId, "missing"]);
        expect(lists).toHaveLength(2);
        expect(lists.find(({ sql }) => sql === "?")?.values).toEqual([escapedId]);
        const ids: number[] = [];
        for (const list of lists) {
          const result = await db
            .prepare(`SELECT id FROM set_rows WHERE label IN (${list.sql})`)
            .bind(...list.values)
            .all<{ id: number }>();
          ids.push(...result.results.map(({ id }) => id));
        }
        expect(ids.sort()).toEqual([1, 2]);
      });
    });

    it("splits multi-byte JSON by bytes while preserving rows across chunks", async () => {
      await withTable(async (db) => {
        // JS length fits one chunk, UTF-8 bytes require two.
        const text = "😀".repeat(220_000);
        const rows = Array.from({ length: 3 }, (_, id) => ({
          id,
          label: `${text}${id}`,
          value: id,
        }));
        const statements = bulkInsertStatements(db, "set_rows", rows);
        expect(statements).toHaveLength(2);
        await db.batch(statements);
        expect(
          (await db.prepare("SELECT id, value FROM set_rows ORDER BY id").all()).results
        ).toEqual(rows.map(({ id, value }) => ({ id, value })));
        const lists = idListBatches(
          db,
          rows.map(({ label }) => label)
        );
        expect(lists).toHaveLength(2);
        for (const list of lists) {
          expect(new TextEncoder().encode(list.values[0] as string).byteLength).toBeLessThanOrEqual(
            MAX_SQLITE_JSON_BYTES
          );
          expect(
            (
              await db
                .prepare(`SELECT id FROM set_rows WHERE label IN (${list.sql})`)
                .bind(...list.values)
                .all()
            ).results.length
          ).toBeGreaterThan(0);
        }
      });
    });

    it("rolls back earlier JSON chunks and surrounding statements on a late constraint error", async () => {
      await withTable(async (db) => {
        await db.prepare("INSERT INTO set_rows VALUES (0, 'existing', 7)").run();
        const text = "😀".repeat(220_000);
        const inserts = bulkInsertStatements(db, "set_rows", [
          { id: 1, label: `${text}a`, value: 1 },
          { id: 2, label: `${text}b`, value: 2 },
          { id: 3, label: `${text}c`, value: 3 },
          { id: 4, label: "existing", value: 4 },
        ]);
        expect(inserts).toHaveLength(2);
        await expect(
          db.batch([db.prepare("UPDATE set_rows SET value = 8"), ...inserts])
        ).rejects.toThrow();
        expect((await db.prepare("SELECT * FROM set_rows").all()).results).toEqual([
          { id: 0, label: "existing", value: 7 },
        ]);
      });
    });

    it("rejects an oversized individual JSON row before executing any writes", async () => {
      await withTable(async (db) => {
        expect(() =>
          bulkInsertStatements(db, "set_rows", [
            { id: 1, label: "x".repeat(MAX_SQLITE_JSON_BYTES), value: 1 },
          ])
        ).toThrow(/byte limit/);
        expect(await db.prepare("SELECT COUNT(*) AS n FROM set_rows").first()).toEqual({ n: 0 });
      });
    });

    it("keeps portable VALUES and IN-list fallbacks when capabilities are absent", async () => {
      await withTable(async (engine) => {
        const db: SqlDatabase = {
          prepare: (sql) => engine.prepare(sql),
          batch: (statements) => engine.batch(statements),
        };
        const rows = Array.from({ length: 101 }, (_, id) => ({
          id,
          label: `row-${id}`,
          value: id,
        }));
        const statements = bulkInsertStatements(db, "set_rows", rows);
        expect(statements).toHaveLength(4);
        await db.batch(statements);
        expect(
          idListBatches(
            db,
            rows.map(({ label }) => label)
          ).map(({ values }) => values.length)
        ).toEqual([100, 1]);
        expect((await db.prepare("SELECT * FROM set_rows ORDER BY id").all()).results).toEqual(
          rows
        );
      });
    });

    it("retains binary binding behavior through the portable insert fallback", async () => {
      await withTable(async (db) => {
        await db.batch(
          bulkInsertStatements(db, "set_rows", [
            { id: 1, label: "binary", value: new Uint8Array([0, 255]) },
          ])
        );
        expect(
          await db
            .prepare("SELECT typeof(value) AS type, hex(value) AS bytes FROM set_rows")
            .first()
        ).toEqual({ type: "blob", bytes: "00FF" });
      });
    });

    it("rejects mismatched column sets before choosing an engine path", async () => {
      await withTable(async (db) => {
        expect(() => bulkInsertStatements(db, "set_rows", [{ id: 1 }, { label: "bad" }])).toThrow(
          /disagree on columns/
        );
      });
    });
  });
}
