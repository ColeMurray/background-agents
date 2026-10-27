import {
  copyFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { applyMigrations } from "./migrate";
import {
  CODEX_MIGRATION_SEED,
  CODEX_MIGRATION_TABLES,
  CODEX_MIGRATION_SCHEMA_OBJECTS,
} from "../../test/codex-migration-fixture";

it("upgrades a full populated pre-Codex database without rebuilding FK parent tables", () => {
  const directory = resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../../terraform/d1/migrations"
  );
  const baseline = mkdtempSync(join(tmpdir(), "codex-migration-"));
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON");
    for (const file of readdirSync(directory).filter(
      (file) => file.endsWith(".sql") && file < "0087"
    )) {
      copyFileSync(join(directory, file), join(baseline, file));
    }
    applyMigrations(db, baseline);
    for (const query of CODEX_MIGRATION_SEED) db.exec(query);
    const before = CODEX_MIGRATION_TABLES.map((table) =>
      db.prepare(`SELECT * FROM ${table}`).all()
    );
    const schema = db.prepare(CODEX_MIGRATION_SCHEMA_OBJECTS).all();
    // A failure after the DDL must roll back both parents and the ledger.
    writeFileSync(
      join(baseline, "0087_codex_harness.sql"),
      readFileSync(join(directory, "0087_codex_harness.sql"), "utf8") +
        "\nUPDATE sessions SET harness='invalid';\n"
    );
    expect(() => applyMigrations(db, baseline)).toThrow();
    expect(
      CODEX_MIGRATION_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all())
    ).toEqual(before);
    expect(db.prepare("SELECT * FROM _schema_migrations WHERE version='0087'").all()).toEqual([]);
    expect(() => db.exec("UPDATE sessions SET harness='codex'")).toThrow();
    // Apply the real 0087 alone: later migrations may add columns to these tables.
    copyFileSync(
      join(directory, "0087_codex_harness.sql"),
      join(baseline, "0087_codex_harness.sql")
    );
    expect(applyMigrations(db, baseline)).toContain("0087_codex_harness.sql");
    expect(
      CODEX_MIGRATION_TABLES.map((table) => db.prepare(`SELECT * FROM ${table}`).all())
    ).toEqual(before);
    expect(db.prepare(CODEX_MIGRATION_SCHEMA_OBJECTS).all()).toEqual(schema);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    db.exec(
      "UPDATE sessions SET harness='codex' WHERE id='child'; UPDATE automations SET harness='codex'"
    );
    expect(() => db.exec("UPDATE sessions SET harness='unknown'")).toThrow();
    expect(() => db.exec("UPDATE automations SET harness='unknown'")).toThrow();
    db.exec("INSERT INTO sessions (id, created_at, updated_at) VALUES ('default', 1, 1)");
    expect(db.prepare("SELECT harness FROM sessions WHERE id='default'").get()).toEqual({
      harness: "opencode",
    });
    db.exec(
      "INSERT INTO automations (id, name, instructions, model, created_by, created_at, updated_at) VALUES ('default', 'Default', 'Work', 'model', 'owner', 1, 1)"
    );
    expect(db.prepare("SELECT harness FROM automations WHERE id='default'").get()).toEqual({
      harness: "opencode",
    });
    db.exec("DELETE FROM sessions WHERE id='parent'");
    for (const table of [
      "session_repositories",
      "child_admission_leases",
      "session_collaborators",
    ]) {
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual([]);
    }
    expect(
      db.prepare("SELECT * FROM session_model_provider_auth WHERE session_id='parent'").all()
    ).toEqual([]);
    expect(() => db.exec("DELETE FROM automations WHERE id='automation'")).toThrow();
    db.exec(
      "DELETE FROM automation_runs; DELETE FROM automation_environments; DELETE FROM automations WHERE id='automation'"
    );
    expect(db.prepare("SELECT * FROM automation_model_provider_auth").all()).toEqual([]);
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    db.close();
    rmSync(baseline, { recursive: true, force: true });
  }
});
