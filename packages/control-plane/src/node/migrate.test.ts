import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyMigrations, listMigrations } from "./migrate";

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

  it("rejects files without a numeric prefix and duplicate prefixes before applying anything", () => {
    writeFileSync(join(dir, "0001_first.sql"), "CREATE TABLE first (id INTEGER);");
    writeFileSync(join(dir, "notes.sql"), "CREATE TABLE notes (id INTEGER);");
    expect(() => applyMigrations(db, dir)).toThrow("without a leading numeric prefix: notes.sql");
    rmSync(join(dir, "notes.sql"));

    writeFileSync(join(dir, "0001_again.sql"), "CREATE TABLE again (id INTEGER);");
    expect(() => applyMigrations(db, dir)).toThrow("Duplicate migration version prefix 0001");
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
});
