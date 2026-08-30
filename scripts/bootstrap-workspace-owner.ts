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

export interface BootstrapCliOptions {
  database: string;
  userId: string;
  execute: boolean;
}

export interface BootstrapSqlOptions {
  userId: string;
  execute: boolean;
  auditId: string;
  now: number;
}

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

export function buildBootstrapSql(options: BootstrapSqlOptions): string {
  const userId = sqlLiteral(options.userId);
  const auditId = sqlLiteral(options.auditId);
  const requestId = sqlLiteral(`operator-cli:${options.auditId}`);
  const now = sqlLiteral(options.now);
  const ownerRoleId = sqlLiteral(OWNER_ROLE_ID);
  const targetHasOwner = `EXISTS (
    SELECT 1 FROM user_role_assignments assignment
    WHERE assignment.user_id = ${userId} AND assignment.role_id = ${ownerRoleId}
  )`;
  const completedForTarget = `EXISTS (
    SELECT 1 FROM workspace_bootstrap
    WHERE singleton = 1 AND owner_user_id = ${userId} AND assignment_completed_at IS NOT NULL
  )`;
  const schemaReady = `(SELECT COUNT(*) FROM pragma_table_info('users')
    WHERE name IN ('id', 'access_status', 'authorization_version', 'last_authorization_mutation_id', 'updated_at')) = 5
  AND (SELECT COUNT(*) FROM pragma_table_info('roles')
    WHERE name IN ('id', 'key', 'is_system')) = 3
  AND (SELECT COUNT(*) FROM pragma_table_info('user_role_assignments')
    WHERE name IN ('user_id', 'role_id', 'assigned_by', 'assigned_at')) = 4
  AND (SELECT COUNT(*) FROM pragma_table_info('workspace_bootstrap')
    WHERE name IN ('singleton', 'owner_user_id', 'claimed_at', 'assignment_completed_at')) = 4
  AND (SELECT COUNT(*) FROM pragma_table_info('authorization_audit_events')
    WHERE name IN (
      'id', 'occurred_at', 'request_id', 'policy_id', 'principal_kind',
      'actor_service_snapshot', 'authorization_version', 'action', 'resource_type',
      'target_user_id_snapshot', 'decision_outcome', 'operation_result', 'reason_code', 'metadata_json'
    )) = 14`;
  const preconditions = `${schemaReady}
  AND (SELECT COUNT(*) FROM users WHERE id = ${userId}) = 1
  AND (SELECT COUNT(*) FROM user_role_assignments WHERE user_id = ${userId}) = 1
  AND EXISTS (
    SELECT 1 FROM users WHERE id = ${userId} AND access_status = 'active'
  )
  AND EXISTS (
    SELECT 1 FROM roles
    WHERE id = ${ownerRoleId} AND key = 'owner' AND is_system = 1
  )
  AND NOT EXISTS (
    SELECT 1 FROM users other_user
    JOIN user_role_assignments other_assignment ON other_assignment.user_id = other_user.id
    WHERE other_assignment.role_id = ${ownerRoleId}
      AND other_user.access_status = 'active' AND other_user.id <> ${userId}
  )
  AND NOT EXISTS (
    SELECT 1 FROM workspace_bootstrap
    WHERE singleton = 1 AND owner_user_id <> ${userId}
      AND assignment_completed_at IS NOT NULL
  )`;

  const preflight = `SELECT 'preflight' AS report,
  CASE
    WHEN NOT (${schemaReady}) THEN 'refused'
    WHEN (SELECT COUNT(*) FROM users WHERE id = ${userId}) <> 1 THEN 'refused'
    WHEN (SELECT COUNT(*) FROM user_role_assignments WHERE user_id = ${userId}) <> 1 THEN 'refused'
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND access_status = 'active') THEN 'refused'
    WHEN NOT EXISTS (
      SELECT 1 FROM roles WHERE id = ${ownerRoleId} AND key = 'owner' AND is_system = 1
    ) THEN 'refused'
    WHEN EXISTS (
      SELECT 1 FROM users other_user
      JOIN user_role_assignments other_assignment ON other_assignment.user_id = other_user.id
      WHERE other_assignment.role_id = ${ownerRoleId}
        AND other_user.access_status = 'active' AND other_user.id <> ${userId}
    ) THEN 'refused'
    WHEN EXISTS (
      SELECT 1 FROM workspace_bootstrap
      WHERE singleton = 1 AND owner_user_id <> ${userId}
        AND assignment_completed_at IS NOT NULL
    ) THEN 'refused'
    WHEN ${targetHasOwner} AND ${completedForTarget} THEN 'no-op'
    ELSE 'ready'
  END AS status,
  CASE
    WHEN NOT (${schemaReady}) THEN 'required RBAC schema is missing or incomplete'
    WHEN (SELECT COUNT(*) FROM users WHERE id = ${userId}) <> 1 THEN 'target user does not exist exactly once'
    WHEN (SELECT COUNT(*) FROM user_role_assignments WHERE user_id = ${userId}) <> 1 THEN 'target must have exactly one role assignment'
    WHEN NOT EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND access_status = 'active') THEN 'target user is not active'
    WHEN NOT EXISTS (
      SELECT 1 FROM roles WHERE id = ${ownerRoleId} AND key = 'owner' AND is_system = 1
    ) THEN 'built-in Owner role is missing or inconsistent'
    WHEN EXISTS (
      SELECT 1 FROM users other_user
      JOIN user_role_assignments other_assignment ON other_assignment.user_id = other_user.id
      WHERE other_assignment.role_id = ${ownerRoleId}
        AND other_user.access_status = 'active' AND other_user.id <> ${userId}
    ) THEN 'another active Owner already exists'
    WHEN EXISTS (
      SELECT 1 FROM workspace_bootstrap
      WHERE singleton = 1 AND owner_user_id <> ${userId}
        AND assignment_completed_at IS NOT NULL
    ) THEN 'bootstrap was completed for another user'
    WHEN ${targetHasOwner} AND ${completedForTarget} THEN 'selected user is already the completed active Owner'
    ELSE 'selected user can be bootstrapped'
  END AS detail,
  ${userId} AS user_id;`;

  if (!options.execute) return `${preflight}\n`;

  return `${preflight}

-- Deliberately overflow on any failed precondition. Wrangler executes a D1
-- SQL file atomically, so this aborts before mutation and rolls back the file.
SELECT CASE WHEN ${preconditions}
  THEN 1 ELSE abs(-9223372036854775808) END AS precondition_guard;

UPDATE users
SET authorization_version = authorization_version + 1,
    last_authorization_mutation_id = ${auditId},
    updated_at = ${now}
WHERE id = ${userId} AND access_status = 'active'
  AND NOT (${targetHasOwner} AND ${completedForTarget});

UPDATE user_role_assignments
SET role_id = ${ownerRoleId}, assigned_by = NULL, assigned_at = ${now}
WHERE user_id = ${userId}
  AND EXISTS (
    SELECT 1 FROM users
    WHERE id = ${userId} AND last_authorization_mutation_id = ${auditId}
  );

INSERT INTO workspace_bootstrap
  (singleton, owner_user_id, claimed_at, assignment_completed_at)
SELECT 1, ${userId}, ${now}, ${now}
WHERE EXISTS (
  SELECT 1 FROM users
  WHERE id = ${userId} AND last_authorization_mutation_id = ${auditId}
)
ON CONFLICT(singleton) DO UPDATE SET
  owner_user_id = excluded.owner_user_id,
  claimed_at = excluded.claimed_at,
  assignment_completed_at = excluded.assignment_completed_at
WHERE EXISTS (
  SELECT 1 FROM users
  WHERE id = ${userId} AND last_authorization_mutation_id = ${auditId}
);

INSERT INTO authorization_audit_events
  (id, occurred_at, request_id, policy_id, principal_kind,
   actor_service_snapshot, authorization_version, action, resource_type,
   target_user_id_snapshot, decision_outcome, operation_result, reason_code, metadata_json)
SELECT ${auditId}, ${now}, ${requestId}, 'workspace.owner_bootstrapped', 'service',
       'operator-cli', authorization_version, 'workspace.owner_bootstrapped', 'workspace',
       ${userId}, 'allowed', 'succeeded', 'operator_cli', '{}'
FROM users
WHERE id = ${userId} AND last_authorization_mutation_id = ${auditId};

-- The last statement before reporting fails the entire atomic file if any
-- write was incomplete. A true idempotent no-op also satisfies this state.
SELECT CASE WHEN ${preconditions}
  AND ${targetHasOwner} AND ${completedForTarget}
  AND (
    NOT EXISTS (SELECT 1 FROM users WHERE id = ${userId} AND last_authorization_mutation_id = ${auditId})
    OR EXISTS (
      SELECT 1 FROM authorization_audit_events
      WHERE id = ${auditId} AND target_user_id_snapshot = ${userId}
        AND actor_service_snapshot = 'operator-cli' AND metadata_json = '{}'
    )
  )
  THEN 1 ELSE abs(-9223372036854775808) END AS postcondition_guard;

SELECT 'postcondition' AS report,
  CASE WHEN EXISTS (
    SELECT 1 FROM users WHERE id = ${userId} AND last_authorization_mutation_id = ${auditId}
  ) THEN 'executed' ELSE 'no-op' END AS status,
  u.id AS user_id,
  u.access_status,
  u.authorization_version,
  assignment.role_id,
  bootstrap.assignment_completed_at,
  EXISTS(SELECT 1 FROM authorization_audit_events WHERE id = ${auditId}) AS audit_written
FROM users u
JOIN user_role_assignments assignment ON assignment.user_id = u.id
JOIN workspace_bootstrap bootstrap
  ON bootstrap.singleton = 1 AND bootstrap.owner_user_id = u.id
WHERE u.id = ${userId};
`;
}

interface WranglerResult {
  results?: Array<Record<string, unknown>>;
  success?: boolean;
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

function preflight(database: string, userId: string): string {
  const sql = buildBootstrapSql({ userId, execute: false, auditId: "unused", now: 0 });
  const rows = reportRows(runWrangler(database, ["--command", sql]));
  const status = rows.find((row) => row.report === "preflight")?.status;
  if (typeof status !== "string") throw new Error("Wrangler returned no Owner bootstrap preflight");
  return status;
}

export async function run(options: BootstrapCliOptions): Promise<void> {
  console.error(`${options.execute ? "Executing" : "Dry-running"} Owner bootstrap on remote D1...`);
  const status = preflight(options.database, options.userId);
  if (status === "refused") throw new Error("Owner bootstrap preflight was refused");
  if (status === "no-op") return;
  if (!options.execute) {
    console.error("Dry run only. Re-run with --execute after reviewing the preflight result.");
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), "open-inspect-owner-bootstrap-"));
  const sqlPath = join(directory, "bootstrap.sql");
  try {
    await writeFile(
      sqlPath,
      buildBootstrapSql({
        userId: options.userId,
        execute: true,
        auditId: crypto.randomUUID(),
        now: Date.now(),
      }),
      { encoding: "utf8", mode: 0o600 }
    );
    runWrangler(options.database, ["--file", sqlPath]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  if (preflight(options.database, options.userId) !== "no-op") {
    throw new Error("Owner bootstrap postcondition verification failed");
  }
  console.error(
    "Owner bootstrap command completed; verify /health reports rbac.ownerBootstrap=complete."
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
