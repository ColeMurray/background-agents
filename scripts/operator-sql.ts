import { spawnSync } from "node:child_process";
import { statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DatabaseTarget =
  { database: string; sqlite?: never } | { sqlite: string; database?: never };

export type WranglerRunner = (database: string, operation: readonly string[]) => string;

export function databaseTarget(database?: string, sqlite?: string): DatabaseTarget {
  if ((database !== undefined) === (sqlite !== undefined)) {
    throw new Error("Specify exactly one of --database <D1-name> or --sqlite <existing-path>");
  }
  if (database !== undefined) {
    if (!database.trim()) throw new Error("--database must not be empty");
    return { database: database.trim() };
  }
  if (!sqlite?.trim() || sqlite === ":memory:" || sqlite.startsWith("file:")) {
    throw new Error("--sqlite must name an existing database file");
  }
  return { sqlite };
}

export function sqlLiteral(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Unsafe SQL integer: ${value}`);
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

function runWrangler(database: string, operation: readonly string[]): string {
  const child = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", database, "--remote", ...operation, "--json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (child.error) throw child.error;
  if (child.status !== 0) {
    throw new Error(`Operator SQL refused or failed:\n${child.stderr || child.stdout}`);
  }
  return child.stdout;
}

/** Match D1's result-bearing /query transaction, not its non-result-bearing file import. */
export function runSql(
  target: DatabaseTarget,
  statements: readonly string[],
  write: boolean,
  remoteRunner: WranglerRunner = runWrangler
): string {
  const validated = databaseTarget(target.database, target.sqlite);
  if (validated.database !== undefined) {
    return remoteRunner(validated.database, ["--command", statements.join("\n")]);
  }

  const path = resolve(validated.sqlite);
  // DatabaseSync otherwise creates a missing file. Never initialize an operator target.
  if (!statSync(path).isFile()) throw new Error("--sqlite must name an existing database file");
  const database = new DatabaseSync(path, { readOnly: !write });
  try {
    database.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
    database.exec(write ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const results = statements.map((sql) => ({
        success: true,
        results: database.prepare(sql).all(),
      }));
      // Serialize before committing so serialization failures also roll back.
      const output = JSON.stringify(results);
      database.exec("COMMIT");
      return output;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
