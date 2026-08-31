/**
 * Merge a split canonical user pair (issue #1290). Converges the loser user's
 * identities (which are also the Better Auth accounts post-consolidation),
 * coding and browser sessions, automations, SCM tokens, and read states onto
 * the survivor, then deletes the emptied loser row.
 *
 * Survivor selection: normally the row that owns history and attribution;
 * for a subject/email collision split (`auth.subject_email_collision` in
 * worker logs enumerates the live cases), normally the row the person
 * already signs into.
 *
 * Dry-run is the default — it prints exact per-table counts and writes
 * nothing. Pass --execute to apply. The merge is idempotent: re-running a
 * completed merge is a zero-count no-op. Execute mode submits the complete
 * graph mutation as one result-bearing D1 batch.
 *
 * Usage:
 *   node --experimental-transform-types scripts/merge-split-users.ts \
 *     --database <d1-database-name> --survivor <user-id> --loser <user-id>
 *     [--execute]
 *
 * Flags: --local (target the local wrangler simulator), --verbose (print SQL).
 * Requires wrangler auth (CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID or
 * `wrangler login`).
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type {
  SqlDatabase,
  SqlResult,
  SqlStatement,
} from "../packages/control-plane/src/db/sql-database.ts";
import { mergeUsers, UserMergeError } from "../packages/control-plane/src/db/user-merge.ts";

// ---------------------------------------------------------------------------
// Wrangler-backed SqlDatabase (the `wrangler d1 execute` idiom, wrapped)
// ---------------------------------------------------------------------------

interface WranglerQueryResult {
  results: Record<string, unknown>[];
  success: boolean;
  meta?: { changes?: number };
}

/** Minimal process result used to test Wrangler orchestration without spawning. */
export interface WranglerProcessResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

/** Injectable runner for Wrangler CLI orchestration tests. */
export type WranglerRunner = (args: string[]) => WranglerProcessResult;

const runWrangler: WranglerRunner = (args) =>
  spawnSync("npx", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function sqlLiteral(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite SQL number: ${value}`);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error(`Unsupported SQL parameter type: ${typeof value}`);
}

/**
 * Inline positional `?` parameters as escaped literals (wrangler --command
 * has no binding). Every `?` character is treated as a placeholder — a
 * literal `?` inside a quoted string or comment would make the placeholder
 * count disagree with the bound parameter count and fail loudly below, never
 * silently misbind. None of the statements this script executes contain one;
 * if a future statement must, extend this to a quote-aware scan.
 */
function inlineParams(sql: string, params: unknown[]): string {
  let index = 0;
  const rendered = sql.replaceAll("?", () => {
    if (index >= params.length) throw new Error(`Too few parameters for statement: ${sql}`);
    return sqlLiteral(params[index++]);
  });
  if (index !== params.length) {
    throw new Error(`Too many parameters for statement: ${sql}`);
  }
  return rendered;
}

export class WranglerD1Database implements SqlDatabase {
  constructor(
    private readonly databaseName: string,
    private readonly remote: boolean,
    private readonly verbose: boolean,
    private readonly runner: WranglerRunner = runWrangler
  ) {}

  prepare(query: string): SqlStatement {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const db = this;
    let params: unknown[] = [];
    const statement: SqlStatement & { render(): string } = {
      bind(...values: unknown[]) {
        params = values;
        return statement;
      },
      render() {
        return inlineParams(query, params);
      },
      async first<T = Record<string, unknown>>() {
        const [result] = db.execute([statement.render()]);
        return (result?.results[0] ?? null) as T | null;
      },
      async run<T = Record<string, unknown>>() {
        const [result] = db.execute([statement.render()]);
        return toSqlResult<T>(result);
      },
      async all<T = Record<string, unknown>>() {
        const [result] = db.execute([statement.render()]);
        return toSqlResult<T>(result);
      },
    };
    return statement;
  }

  // Remote --command sends semicolon-separated statements to D1's /query
  // batch API. D1 executes the batch transactionally and Wrangler preserves
  // one positional result (including meta.changes) per statement.
  async batch<T = unknown>(statements: SqlStatement[]): Promise<SqlResult<T>[]> {
    const rendered = statements.map((entry) => (entry as { render(): string }).render());
    const results = this.execute(rendered);
    if (results.length !== statements.length) {
      throw new Error(
        `Wrangler returned ${results.length} results for ${statements.length} batched statements`
      );
    }
    return results.map((result) => toSqlResult<T>(result));
  }

  private execute(statements: string[]): WranglerQueryResult[] {
    if (statements.length === 0) return [];
    if (this.verbose) {
      for (const statement of statements) console.error(`[sql] ${statement}`);
    }
    return this.executeOperation(["--command", statements.join(";\n")]);
  }

  private executeOperation(operation: string[]): WranglerQueryResult[] {
    const args = [
      "wrangler",
      "d1",
      "execute",
      this.databaseName,
      this.remote ? "--remote" : "--local",
      "--json",
      ...operation,
    ];
    const child = this.runner(args);
    if (child.status !== 0) {
      throw new Error(`wrangler d1 execute failed:\n${child.stderr || child.stdout}`);
    }
    const parsed = JSON.parse(child.stdout) as WranglerQueryResult[];
    const failed = parsed.find((result) => !result.success);
    if (failed) {
      throw new Error(`Statement failed: ${JSON.stringify(failed)}`);
    }
    return parsed;
  }
}

function toSqlResult<T>(result: WranglerQueryResult | undefined): SqlResult<T> {
  return {
    results: (result?.results ?? []) as T[],
    meta: { changes: result?.meta?.changes ?? 0 },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

interface CliOptions {
  database: string;
  survivorId: string;
  loserId: string;
  execute: boolean;
  local: boolean;
  verbose: boolean;
}

const VALUE_OPTIONS = new Set(["database", "survivor", "loser"]);
const FLAG_OPTIONS = new Set(["execute", "local", "verbose"]);

function parseArgs(argv: string[]): CliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const name = arg.slice(2);
    if (FLAG_OPTIONS.has(name)) {
      flags.add(name);
      continue;
    }
    // Unknown names are rejected before consuming a value: on a destructive
    // tool, a typo (`--exec`, `--survivor-id`) must fail, not silently
    // change what the run does.
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    const value = argv[++index];
    if (value === undefined) throw new Error(`Missing value for --${name}`);
    values.set(name, value);
  }
  const require = (name: string): string => {
    const value = values.get(name);
    if (!value) throw new Error(`--${name} is required`);
    return value;
  };
  return {
    database: require("database"),
    survivorId: require("survivor"),
    loserId: require("loser"),
    execute: flags.has("execute"),
    local: flags.has("local"),
    verbose: flags.has("verbose"),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const db = new WranglerD1Database(options.database, !options.local, options.verbose);

  const result = await mergeUsers(db, {
    survivorId: options.survivorId,
    loserId: options.loserId,
    dryRun: !options.execute,
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.dryRun) {
    console.error("\nDry run only — re-run with --execute to apply.");
    return;
  }

  // Closing check: the loser row and its graph must be gone.
  const residual = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM users WHERE id = ?) +
         (SELECT COUNT(*) FROM user_identities WHERE user_id = ?) +
         (SELECT COUNT(*) FROM sessions WHERE user_id = ?) +
         (SELECT COUNT(*) FROM auth_sessions WHERE userId = ?) AS count`
    )
    .bind(options.loserId, options.loserId, options.loserId, options.loserId)
    .first<{ count: number }>();
  if ((residual?.count ?? 0) > 0) {
    console.error("WARNING: rows still reference the loser id; re-run the merge.");
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    const message = error instanceof UserMergeError ? error.message : String(error);
    console.error(message);
    process.exitCode = 1;
  });
}
