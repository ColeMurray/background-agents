/**
 * Apply the global store's migrations to a Node host's SQLite file, the way
 * `scripts/d1-migrate.sh` applies them to D1.
 *
 * The migration files are the same `terraform/d1/migrations/*.sql`; the
 * ledger is the same `_schema_migrations` table with the same columns, so a
 * D1 export of a production database imports here with its history intact
 * and a file exported back is one D1 recognizes. The rules mirror the
 * script: every file is named `NNNN_description.sql` (the script accepts
 * any numeric prefix but orders by filename, so the width is what keeps
 * its order and this runner's the same), no two files share a version,
 * files apply in filename order, a version already recorded under a
 * different name is a hard error (downstream installations may have used
 * the number), and each migration commits together with its ledger row or
 * not at all.
 *
 * Each migration is checked and applied under one write lock, so two
 * processes opening the same file cannot both apply it: the second finds
 * the ledger row once the first commits. A migration therefore must not
 * control transactions itself; a `COMMIT` inside one would end the runner's
 * transaction early and strand the ledger row.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

const LEDGER_SQL = `CREATE TABLE IF NOT EXISTS _schema_migrations (
  version TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (datetime('now'))
)`;

/** `NNNN_description.sql`: a four-digit version, an underscore, a description. */
const MIGRATION_FILE = /^(\d{4})_.+\.sql$/;

const TRANSACTION_CONTROL = /^(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i;

export interface MigrationFile {
  version: string;
  name: string;
  path: string;
}

/**
 * The migration files in `directory`, in filename order, validated as the
 * deploy script validates them.
 */
export function listMigrations(directory: string): MigrationFile[] {
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".sql"))
    .sort();
  const files: MigrationFile[] = [];
  const seen = new Map<string, string>();
  for (const name of names) {
    const match = MIGRATION_FILE.exec(name);
    if (!match) {
      throw new Error(
        `Migration file ${name} is not named NNNN_description.sql; ` +
          "rename it so it can be tracked and ordered."
      );
    }
    const version = match[1]!;
    const earlier = seen.get(version);
    if (earlier !== undefined) {
      throw new Error(
        `Duplicate migration version ${version}: ${earlier} and ${name}. ` +
          "Renumber the colliding files so each version is unique."
      );
    }
    seen.set(version, name);
    files.push({ version, name, path: join(directory, name) });
  }
  return files;
}

/**
 * Apply every migration in `directory` not yet recorded in the ledger.
 * Returns the names applied, in order.
 */
export function applyMigrations(db: DatabaseSync, directory: string): string[] {
  const files = listMigrations(directory);
  db.exec(LEDGER_SQL);
  const recordedName = db.prepare("SELECT name FROM _schema_migrations WHERE version = ?");
  const record = db.prepare("INSERT INTO _schema_migrations (version, name) VALUES (?, ?)");
  const applied: string[] = [];
  for (const file of files) {
    const sql = readFileSync(file.path, "utf8");
    if (containsTransactionControl(sql)) {
      throw new Error(
        `Migration ${file.name} controls transactions itself; ` +
          "the runner applies each migration as one transaction."
      );
    }
    // The ledger is read under the write lock, so a migration another
    // process applied meanwhile is found recorded rather than applied twice.
    db.exec("BEGIN IMMEDIATE");
    let recorded: { name: string } | undefined;
    try {
      recorded = recordedName.get(file.version) as { name: string } | undefined;
    } catch (error) {
      rollbackQuietly(db);
      throw error;
    }
    if (recorded !== undefined) {
      db.exec("ROLLBACK");
      if (recorded.name !== file.name) {
        throw new Error(
          `Migration version ${file.version} is already recorded as ${recorded.name}; ` +
            `renumber ${file.name} before applying it to this installation.`
        );
      }
      continue;
    }
    try {
      db.exec(sql);
      record.run(file.version, file.name);
      db.exec("COMMIT");
    } catch (error) {
      rollbackQuietly(db);
      throw new Error(`Migration ${file.name} failed: ${errorMessage(error)}`, { cause: error });
    }
    applied.push(file.name);
  }
  return applied;
}

/**
 * Whether any statement in `sql` is transaction control. Comments and
 * quoted text are blanked in one left-to-right pass, so a comment marker
 * inside a literal (`DEFAULT '--'`) or an apostrophe inside a comment
 * (`-- don't`) does not hide or invent a statement boundary. Trigger
 * bodies are skipped, since their `BEGIN … END` is not a transaction; a
 * migration is otherwise plain DDL/DML, so statement starts are what matter.
 */
export function containsTransactionControl(sql: string): boolean {
  let inTrigger = false;
  for (const segment of blankCommentsAndQuotes(sql).split(";")) {
    const statement = segment.trim();
    if (inTrigger) {
      if (/^END\b/i.test(statement)) inTrigger = false;
      continue;
    }
    if (/^CREATE\s+(?:TEMP(?:ORARY)?\s+)?TRIGGER\b/i.test(statement)) {
      inTrigger = true;
      continue;
    }
    if (TRANSACTION_CONTROL.test(statement)) return true;
  }
  return false;
}

/**
 * `sql` with each comment replaced by a space and each string literal or
 * quoted identifier by an empty one. One scan decides which construct each
 * character belongs to, so the two cannot mis-pair each other's delimiters.
 * A doubled quote inside quoted text is an escaped quote; unterminated
 * text runs to the end, as SQLite would read it.
 */
function blankCommentsAndQuotes(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " ";
    } else if (ch === "'" || ch === '"' || ch === "`") {
      i = skipQuoted(sql, i, ch);
      out += ch + ch;
    } else if (ch === "[") {
      const end = sql.indexOf("]", i + 1);
      i = end === -1 ? sql.length : end + 1;
      out += "[]";
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/** The index just past the quoted text opening at `start` with `quote`. */
function skipQuoted(sql: string, start: number, quote: string): number {
  let i = start + 1;
  for (;;) {
    const close = sql.indexOf(quote, i);
    if (close === -1) return sql.length;
    if (sql[close + 1] === quote) {
      i = close + 2;
      continue;
    }
    return close + 1;
  }
}

/** Roll back if a transaction is open; a failed COMMIT leaves one, a failed BEGIN does not. */
function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("ROLLBACK");
  } catch {
    // No transaction to roll back.
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
