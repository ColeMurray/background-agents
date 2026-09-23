import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, containsTransactionControl, listMigrations } from "./migrate";

const MIGRATIONS_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../../terraform/d1/migrations"
);

const ledger = (db: DatabaseSync): Array<{ version: string; name: string }> =>
  db.prepare("SELECT version, name FROM _schema_migrations ORDER BY version").all() as Array<{
    version: string;
    name: string;
  }>;

describe("applyMigrations", () => {
  let dir: string;
  let db: DatabaseSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "migrate-"));
    db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("applies every repository migration from zero and records each in the ledger", () => {
    const files = readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql"));

    const applied = applyMigrations(db, MIGRATIONS_DIR);

    expect(applied).toEqual(listMigrations(MIGRATIONS_DIR).map((file) => file.name));
    expect(applied).toHaveLength(files.length);
    expect(ledger(db).map((row) => row.name)).toEqual(applied);
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get()
    ).toMatchObject({ n: expect.any(Number) });
    // A second run finds everything recorded and applies nothing.
    expect(applyMigrations(db, MIGRATIONS_DIR)).toEqual([]);
  });

  it("applies files in version order and skips the ones already recorded", () => {
    writeFileSync(join(dir, "0002_second.sql"), "CREATE TABLE second (id INTEGER);");
    writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE first (id INTEGER);");
    expect(applyMigrations(db, dir)).toEqual(["0001_first.sql", "0002_second.sql"]);

    writeFileSync(join(dir, "0003_third.sql"), "CREATE TABLE third (id INTEGER);");
    expect(applyMigrations(db, dir)).toEqual(["0003_third.sql"]);
    expect(ledger(db)).toEqual([
      { version: "0001", name: "0001_first.sql" },
      { version: "0002", name: "0002_second.sql" },
      { version: "0003", name: "0003_third.sql" },
    ]);
  });

  it("refuses a version already recorded under a different name", () => {
    writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE first (id INTEGER);");
    applyMigrations(db, dir);
    rmSync(join(dir, "0001_first.sql"));
    writeFileSync(join(dir, "0001_other.sql"), "CREATE TABLE other (id INTEGER);");

    expect(() => applyMigrations(db, dir)).toThrow(
      "version 0001 is already recorded as 0001_first.sql"
    );
  });

  it("rejects misnamed files and duplicate versions before applying anything", () => {
    writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE first (id INTEGER);");
    writeFileSync(join(dir, "notes.sql"), "CREATE TABLE notes (id INTEGER);");
    expect(() => applyMigrations(db, dir)).toThrow("notes.sql is not named NNNN_description.sql");
    rmSync(join(dir, "notes.sql"));

    // An unpadded version would sort differently from the deploy script's
    // filename order, so the width is part of the name.
    writeFileSync(join(dir, "10_tenth.sql"), "CREATE TABLE tenth (id INTEGER);");
    expect(() => applyMigrations(db, dir)).toThrow(
      "10_tenth.sql is not named NNNN_description.sql"
    );
    rmSync(join(dir, "10_tenth.sql"));

    writeFileSync(join(dir, "0001_again.sql"), "CREATE TABLE again (id INTEGER);");
    expect(() => applyMigrations(db, dir)).toThrow("Duplicate migration version 0001");
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'first'").get()
    ).toEqual({
      n: 0,
    });
  });

  it("commits a migration together with its ledger row, or neither", () => {
    writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE first (id INTEGER);");
    writeFileSync(
      join(dir, "0002_broken.sql"),
      "CREATE TABLE partial (id INTEGER);\nINSERT INTO no_such_table VALUES (1);"
    );

    expect(() => applyMigrations(db, dir)).toThrow("Migration 0002_broken.sql failed: ");

    expect(ledger(db).map((row) => row.name)).toEqual(["0001_first.sql"]);
    expect(
      db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'partial'").get()
    ).toEqual({ n: 0 });
    // The next run retries the failed migration once it is fixed.
    writeFileSync(join(dir, "0002_broken.sql"), "CREATE TABLE partial (id INTEGER);");
    expect(applyMigrations(db, dir)).toEqual(["0002_broken.sql"]);
  });

  it("rejects a migration that controls transactions itself, before applying it", () => {
    writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE first (id INTEGER);");
    writeFileSync(
      join(dir, "0002_commits.sql"),
      "-- a COMMIT in a comment is fine\nCREATE TABLE t (v TEXT DEFAULT 'BEGIN');\nCOMMIT;\nCREATE TABLE u (id INTEGER);"
    );

    expect(() => applyMigrations(db, dir)).toThrow(
      "Migration 0002_commits.sql controls transactions itself"
    );
    expect(ledger(db).map((row) => row.name)).toEqual(["0001_first.sql"]);
  });

  it("finds a migration another connection applied meanwhile recorded, not pending", () => {
    const path = join(dir, "global.db");
    const first = new DatabaseSync(path);
    const second = new DatabaseSync(path);
    try {
      writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE first (id INTEGER);");
      expect(applyMigrations(first, dir)).toEqual(["0001_first.sql"]);
      // The second connection checks the ledger under the write lock and
      // sees the row the first committed.
      expect(applyMigrations(second, dir)).toEqual([]);
      expect(ledger(second)).toEqual([{ version: "0001", name: "0001_first.sql" }]);
    } finally {
      first.close();
      second.close();
    }
  });

  it("tells transaction control apart from trigger bodies, comments, and strings", () => {
    expect(
      containsTransactionControl(
        "CREATE TRIGGER t_ai AFTER INSERT ON t\nBEGIN\n  UPDATE t SET n = n + 1;\nEND;\nCREATE TABLE u (v TEXT DEFAULT 'COMMIT'); -- COMMIT here is a comment"
      )
    ).toBe(false);
    expect(containsTransactionControl("CREATE TABLE u (id INTEGER);\nCOMMIT;")).toBe(true);
    expect(containsTransactionControl("begin transaction; CREATE TABLE u (id INTEGER)")).toBe(true);
    expect(containsTransactionControl("SAVEPOINT s; CREATE TABLE u (id INTEGER); RELEASE s")).toBe(
      true
    );
  });

  it("does not let a literal and a comment mis-pair each other's delimiters", () => {
    // A comment marker inside a literal must not swallow the COMMIT after it.
    expect(
      containsTransactionControl(
        "CREATE TABLE t (v TEXT DEFAULT '--'); COMMIT; CREATE TABLE u (id)"
      )
    ).toBe(true);
    expect(
      containsTransactionControl(
        "CREATE TABLE t (v TEXT DEFAULT '/*'); COMMIT; CREATE TABLE u (id)"
      )
    ).toBe(true);
    // An apostrophe inside a comment must not open a literal that swallows the COMMIT.
    expect(containsTransactionControl("-- don't\nCOMMIT;\nINSERT INTO t (v) VALUES ('x')")).toBe(
      true
    );
    // Nor may either invent a statement: quoted text may hold a semicolon and an escaped quote.
    expect(
      containsTransactionControl(
        "INSERT INTO t (v) VALUES ('a; COMMIT; it''s fine');\nCREATE INDEX \"i; COMMIT\" ON t (v);\n/* don't ' COMMIT */\nCREATE TABLE [u; COMMIT] (id)"
      )
    ).toBe(false);
  });

  it("lets several processes open and migrate one fresh file at once, applying each migration once", async () => {
    const migrations = join(dir, "migrations");
    mkdirMigrations(migrations, {
      "0001_first.sql": "CREATE TABLE first (id INTEGER);",
      "0002_second.sql": "CREATE TABLE second (id INTEGER);",
    });
    // The opener is bundled once so plain `node` can run it in each process.
    const entry = join(dir, "open.ts");
    const adapter = resolve(dirname(fileURLToPath(import.meta.url)), "sqlite-database.ts");
    writeFileSync(
      entry,
      `import { openNodeSqlDatabase } from ${JSON.stringify(adapter)};
       openNodeSqlDatabase(process.argv[2], { migrationsDir: process.argv[3] }).close();`
    );
    const script = join(dir, "open.mjs");
    buildSync({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      outfile: script,
      logLevel: "silent",
    });
    const path = join(dir, "global.db");

    const children = Array.from(
      { length: 4 },
      () =>
        new Promise<{ code: number | null; stderr: string }>((done) => {
          const child = spawn(process.execPath, ["--no-warnings", script, path, migrations], {
            stdio: ["ignore", "ignore", "pipe"],
          });
          let stderr = "";
          child.stderr.on("data", (chunk) => (stderr += String(chunk)));
          child.on("exit", (code) => done({ code, stderr }));
        })
    );
    const results = await Promise.all(children);

    expect(results.map((r) => [r.code, r.stderr])).toEqual(results.map(() => [0, ""]));
    const file = new DatabaseSync(path);
    try {
      expect(ledger(file).map((row) => row.name)).toEqual(["0001_first.sql", "0002_second.sql"]);
    } finally {
      file.close();
    }
  });
});

function mkdirMigrations(directory: string, files: Record<string, string>): void {
  mkdirSync(directory);
  for (const [name, sql] of Object.entries(files)) writeFileSync(join(directory, name), sql);
}
