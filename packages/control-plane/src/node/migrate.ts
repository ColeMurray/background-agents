/**
 * Apply the global store's migrations to a Node host's SQLite file, the way
 * `scripts/d1-migrate.sh` applies them to D1.
 *
 * The migration files are the same `terraform/d1/migrations/*.sql`; the
 * ledger is the same `_schema_migrations` table with the same columns, so a
 * D1 export of a production database imports here with its history intact
 * and a file exported back is one D1 recognizes. The rules mirror the
 * script: every file needs a numeric prefix, no two files may share one,
 * files apply in prefix order, a version already recorded under a different
 * name is a hard error (downstream installations may have used the number),
 * and each migration commits together with its ledger row, so a failed
 * migration leaves neither.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS _schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

export interface MigrationFile {
  version: string;
  name: string;
  path: string;
}

/**
 * The migration files in `directory`, in version order, validated as the
 * deploy script validates them.
 */
export function listMigrations(directory: string): MigrationFile[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const invalid = names.filter((name) => !/^[0-9]+/.test(name));
  if (invalid.length > 0) {
    throw new Error(
      `Migration files without a leading numeric prefix: ${invalid.join(", ")}. ` +
        "Rename them as NNNN_description.sql so they can be tracked."
    );
  }
  const files = names.map((name) => ({
    version: /^[0-9]+/.exec(name)![0],
    name,
    path: join(directory, name),
  }));
  const seen = new Map<string, string>();
  for (const file of files) {
    const earlier = seen.get(file.version);
    if (earlier !== undefined) {
      throw new Error(
        `Duplicate migration version prefix ${file.version}: ${earlier} and ${file.name}. ` +
          "Renumber the colliding files so each prefix is unique."
      );
    }
    seen.set(file.version, file.name);
  }
  return files.sort((a, b) => Number(a.version) - Number(b.version) || (a.name < b.name ? -1 : 1));
}

/**
 * Apply every migration in `directory` not yet recorded in the ledger.
 * Returns the names applied, in order.
 */
export function applyMigrations(db: DatabaseSync, directory: string): string[] {
  const files = listMigrations(directory);
  db.exec(LEDGER_SQL);
  const recorded = new Map(
    (
      db.prepare("SELECT version, name FROM _schema_migrations").all() as Array<{
        version: string;
        name: string;
      }>
    ).map((row) => [row.version, row.name])
  );
  const record = db.prepare("INSERT INTO _schema_migrations (version, name) VALUES (?, ?)");
  const applied: string[] = [];
  for (const file of files) {
    const recordedName = recorded.get(file.version);
    if (recordedName !== undefined) {
      if (recordedName !== file.name) {
        throw new Error(
          `Migration version ${file.version} is already recorded as ${recordedName}; ` +
            `renumber ${file.name} before applying it to this installation.`
        );
      }
      continue;
    }
    const sql = readFileSync(file.path, "utf8");
    // The migration and its ledger row commit together, as D1 executes the
    // deploy script's combined file atomically.
    db.exec("BEGIN");
    try {
      db.exec(sql);
      record.run(file.version, file.name);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw new Error(`Migration ${file.name} failed: ${errorMessage(error)}`, { cause: error });
    }
    applied.push(file.name);
  }
  return applied;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
