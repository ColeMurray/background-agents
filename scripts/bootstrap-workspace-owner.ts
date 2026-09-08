/**
 * Bootstrap the first workspace Owner by canonical user ID.
 *
 * Dry-run (remote D1 by default):
 *   npm run rbac:bootstrap-owner -- --database <d1-name> --user <canonical-user-id>
 *
 * Execute after reviewing the preflight result:
 *   npm run rbac:bootstrap-owner -- --database <d1-name> --user <canonical-user-id> --execute
 *
 * Wrangler uses the normal CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID
 * environment variables or the credentials established by `wrangler login`.
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const CANONICAL_USER_ID = /^[0-9a-f]{32}$/;
const OWNER_ROLE_ID = "role_builtin_owner";
const VALUE_OPTIONS = new Set(["database", "user"]);
const FLAG_OPTIONS = new Set(["execute"]);

/** Validated command-line options for the Owner bootstrap operation. */
export interface BootstrapCliOptions {
  database: string;
  userId: string;
  execute: boolean;
}

/** Inputs used to build an Owner bootstrap preflight or execution script. */
export interface BootstrapSqlOptions {
  userId: string;
  execute: boolean;
  auditId: string;
  now: number;
}

/** Parse and validate Owner bootstrap command-line arguments. */
export function parseArgs(argv: string[]): BootstrapCliOptions {
  const values = new Map<string, string>();
  const flags = new Set<string>();

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const name = argument.slice(2);
    if (FLAG_OPTIONS.has(name)) {
      if (flags.has(name)) throw new Error(`Duplicate option: --${name}`);
      flags.add(name);
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) throw new Error(`Unknown option: --${name}`);
    if (values.has(name)) throw new Error(`Duplicate option: --${name}`);
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for --${name}`);
    }
    values.set(name, value);
  }

  const database = values.get("database");
  if (!database?.trim()) throw new Error("--database is required");
  const userId = values.get("user");
  if (!userId) throw new Error("--user is required");
  if (!CANONICAL_USER_ID.test(userId)) {
    throw new Error("--user must be a canonical 32-character lowercase hexadecimal user ID");
  }

  return {
    database: database.trim(),
    userId,
    execute: flags.has("execute"),
  };
}

function sqlLiteral(value: string | number): string {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`Unsafe SQL integer: ${value}`);
    return String(value);
  }
  return `'${value.replaceAll("'", "''")}'`;
}

/** Build guarded SQL for an Owner bootstrap preflight or execution. */
export function buildBootstrapSql(options: BootstrapSqlOptions): string {
  const userId = sqlLiteral(options.userId);
  const auditId = sqlLiteral(options.auditId);
  const requestId = sqlLiteral(`operator-cli:${options.auditId}`);
  const now = sqlLiteral(options.now);
  const ownerRoleId = sqlLiteral(OWNER_ROLE_ID);
  const targetIsOwner = `EXISTS (
    SELECT 1 FROM user_role_assignments assignment
    WHERE assignment.user_id = ${userId} AND assignment.role_id = ${ownerRoleId}
  )`;
  const anotherUnsuspendedOwner = `EXISTS (
    SELECT 1 FROM users owner
    JOIN user_role_assignments assignment ON assignment.user_id = owner.id
    WHERE assignment.role_id = ${ownerRoleId}
      AND owner.suspended_at IS NULL AND owner.id <> ${userId}
  )`;
  const schemaReady = `(SELECT COUNT(*) FROM pragma_table_info('users')
    WHERE name IN ('id', 'suspended_at')) = 2
  AND (SELECT COUNT(*) FROM pragma_table_info('roles')
    WHERE name IN ('id', 'key', 'is_system')) = 3
  AND (SELECT COUNT(*) FROM pragma_table_info('user_role_assignments')
    WHERE name IN ('user_id', 'role_id')) = 2
  AND (SELECT COUNT(*) FROM pragma_table_info('authorization_audit_events')
    WHERE name IN (
      'id', 'occurred_at', 'request_id', 'principal_kind',
       'actor_user_id_snapshot', 'actor_service_snapshot', 'action', 'resource_type',
       'resource_id', 'target_user_id_snapshot', 'reason_code',
       'operation_result', 'metadata_json'
    )) = 13`;
  const commonPreconditions = `${schemaReady}
  AND (SELECT COUNT(*) FROM users WHERE id = ${userId}) = 1
  AND (SELECT COUNT(*) FROM user_role_assignments WHERE user_id = ${userId}) = 1
  AND EXISTS (
    SELECT 1 FROM users WHERE id = ${userId} AND suspended_at IS NULL
  )
  AND EXISTS (
    SELECT 1 FROM roles
    WHERE id = ${ownerRoleId} AND key = 'owner' AND is_system = 1
  )`;
  const ready = `${commonPreconditions}
  AND NOT (${targetIsOwner})
  AND NOT (${anotherUnsuspendedOwner})`;
  const exactAudit = `EXISTS (
    SELECT 1 FROM authorization_audit_events
    WHERE id = ${auditId}
      AND occurred_at = ${now}
      AND request_id = ${requestId}
      AND principal_kind = 'service'
      AND actor_user_id_snapshot IS NULL
      AND actor_service_snapshot = 'operator-cli'
      AND action = 'workspace.owner_bootstrapped'
      AND resource_type = 'workspace'
      AND resource_id IS NULL
      AND target_user_id_snapshot = ${userId}
      AND reason_code = 'operator_cli'
      AND operation_result = 'applied'
      AND json_extract(metadata_json, '$.before.roleId') <> ${ownerRoleId}
      AND json_extract(metadata_json, '$.requested.roleId') = ${ownerRoleId}
      AND json_extract(metadata_json, '$.after.roleId') = ${ownerRoleId}
  )`;

  const preflight = `SELECT 'preflight' AS report,
  CASE
    WHEN NOT (${schemaReady}) THEN 'refused'
    WHEN (SELECT COUNT(*) FROM users WHERE id = ${userId}) <> 1 THEN 'refused'
    WHEN (SELECT COUNT(*) FROM user_role_assignments WHERE user_id = ${userId}) <> 1 THEN 'refused'
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND suspended_at IS NULL) THEN 'refused'
    WHEN NOT EXISTS (
      SELECT 1 FROM roles WHERE id = ${ownerRoleId} AND key = 'owner' AND is_system = 1
    ) THEN 'refused'
    WHEN ${anotherUnsuspendedOwner} THEN 'refused'
    WHEN ${targetIsOwner} THEN 'no-op'
    ELSE 'ready'
  END AS status,
  CASE
    WHEN NOT (${schemaReady}) THEN 'required RBAC schema is missing or incomplete'
    WHEN (SELECT COUNT(*) FROM users WHERE id = ${userId}) <> 1 THEN 'target user does not exist exactly once'
    WHEN (SELECT COUNT(*) FROM user_role_assignments WHERE user_id = ${userId}) <> 1 THEN 'target must have exactly one role assignment'
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND suspended_at IS NULL) THEN 'target user is suspended'
    WHEN NOT EXISTS (
      SELECT 1 FROM roles WHERE id = ${ownerRoleId} AND key = 'owner' AND is_system = 1
    ) THEN 'built-in Owner role is missing or inconsistent'
    WHEN ${anotherUnsuspendedOwner} THEN 'another unsuspended Owner already exists'
    WHEN ${targetIsOwner} THEN 'selected user is already the current unsuspended Owner'
    ELSE 'selected user can be bootstrapped'
  END AS detail,
  ${userId} AS user_id,
  (SELECT suspended_at FROM users WHERE id = ${userId}) AS suspended_at,
  (SELECT role_id FROM user_role_assignments WHERE user_id = ${userId}) AS role_id;`;

  if (!options.execute) return `${preflight}\n`;

  return `${preflight}

INSERT INTO authorization_audit_events
  (id, occurred_at, request_id, principal_kind,
   actor_service_snapshot, action, resource_type,
    target_user_id_snapshot, reason_code, operation_result, metadata_json)
SELECT ${auditId}, ${now}, ${requestId}, 'service',
       'operator-cli', 'workspace.owner_bootstrapped', 'workspace',
       ${userId}, 'operator_cli', 'applied',
       json_object(
         'before', json_object('roleId', (
           SELECT role_id FROM user_role_assignments WHERE user_id = ${userId}
         )),
         'requested', json_object('roleId', ${ownerRoleId}),
         'after', json_object('roleId', ${ownerRoleId})
       )
WHERE ${ready};

UPDATE user_role_assignments
SET role_id = ${ownerRoleId}
WHERE user_id = ${userId} AND (${ready}) AND ${exactAudit};

SELECT 'postcondition' AS report,
  CASE
    WHEN (${targetIsOwner}) AND (${exactAudit}) THEN 'executed'
    WHEN ${targetIsOwner} THEN 'no-op'
    ELSE 'refused'
  END AS status,
  u.id AS user_id,
  u.suspended_at,
  assignment.role_id,
  EXISTS(SELECT 1 FROM authorization_audit_events WHERE id = ${auditId}) AS audit_written
FROM users u
JOIN user_role_assignments assignment ON assignment.user_id = u.id
WHERE u.id = ${userId};
`;
}

interface WranglerResult {
  results?: Array<Record<string, unknown>>;
  success?: boolean;
}

type WranglerRunner = (database: string, operation: readonly string[]) => string;

/** Injectable side effects for deterministic bootstrap orchestration tests. */
export interface BootstrapRunDependencies {
  runWrangler?: WranglerRunner;
  randomUUID?: () => string;
  now?: () => number;
}

function reportRows(stdout: string): Array<Record<string, unknown>> {
  const parsed = JSON.parse(stdout) as WranglerResult[];
  const rows = parsed.flatMap((result) => result.results ?? []).filter((row) => row.report);
  for (const row of rows) console.log(JSON.stringify(row));
  return rows;
}

function runWrangler(database: string, operation: readonly string[]): string {
  const child = spawnSync(
    "npx",
    ["wrangler", "d1", "execute", database, "--remote", ...operation, "--json"],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }
  );
  if (child.status !== 0) {
    throw new Error(`Owner bootstrap refused or failed:\n${child.stderr || child.stdout}`);
  }
  return child.stdout;
}

function preflight(database: string, userId: string, runner: WranglerRunner): string {
  const sql = buildBootstrapSql({ userId, execute: false, auditId: "unused", now: 0 });
  const rows = reportRows(runner(database, ["--command", sql]));
  const status = rows.find((row) => row.report === "preflight")?.status;
  if (typeof status !== "string") throw new Error("Wrangler returned no Owner bootstrap preflight");
  return status;
}

/** Run the remote Owner bootstrap workflow and verify its postcondition. */
export async function run(
  options: BootstrapCliOptions,
  dependencies: BootstrapRunDependencies = {}
): Promise<void> {
  const runner = dependencies.runWrangler ?? runWrangler;
  console.error(`${options.execute ? "Executing" : "Dry-running"} Owner bootstrap on remote D1...`);
  const status = preflight(options.database, options.userId, runner);
  if (status === "refused") throw new Error("Owner bootstrap preflight was refused");
  if (status === "no-op") return;
  if (!options.execute) {
    console.error("Dry run only. Re-run with --execute after reviewing the preflight result.");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "open-inspect-owner-bootstrap-"));
  const sqlPath = join(directory, "bootstrap.sql");
  let executionRows: Array<Record<string, unknown>>;
  try {
    const auditId = dependencies.randomUUID?.() ?? crypto.randomUUID();
    const now = dependencies.now?.() ?? Date.now();
    await writeFile(
      sqlPath,
      buildBootstrapSql({
        userId: options.userId,
        execute: true,
        auditId,
        now,
      }),
      { encoding: "utf8", mode: 0o600 }
    );
    executionRows = reportRows(runner(options.database, ["--file", sqlPath]));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  const postcondition = executionRows.find((row) => row.report === "postcondition");
  if (postcondition?.status === "no-op") {
    throw new Error("Owner bootstrap did not execute because ownership changed concurrently");
  }
  if (postcondition?.status !== "executed" || Number(postcondition.audit_written) !== 1) {
    throw new Error("Owner bootstrap execution did not prove its exact audit and assignment");
  }
  console.error(
    "Owner bootstrap command completed; verify /health reports ownerAssignment=present."
  );
}

async function main(): Promise<void> {
  await run(parseArgs(process.argv.slice(2)));
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
