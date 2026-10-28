/**
 * Inspect/export managed rules, or freeze/unfreeze API policy writes.
 *
 * node scripts/admission-policy-maintenance.ts status --database <D1-name>
 * node scripts/admission-policy-maintenance.ts freeze --sqlite <existing-path> --expected-revision <n>
 * Add --execute to apply a reviewed freeze/unfreeze. Status is always read-only.
 * Deployments must be stopped and their actual admission baseline kept stable separately.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseStoredAdmissionPolicy,
  type StoredAdmissionPolicy,
} from "../packages/shared/src/admission-settings.ts";
import {
  databaseTarget,
  runSql,
  sqlLiteral,
  type DatabaseTarget,
  type WranglerRunner,
} from "./operator-sql.ts";

type Action = "status" | "freeze" | "unfreeze";
export type MaintenanceOptions = DatabaseTarget & {
  action: Action;
  expectedRevision?: number;
  execute: boolean;
};

export function parseArgs(argv: string[]): MaintenanceOptions {
  const [action, ...args] = argv;
  if (action !== "status" && action !== "freeze" && action !== "unfreeze") {
    throw new Error("Specify an action: status, freeze, or unfreeze");
  }
  const values = new Map<string, string>();
  let execute = false;
  for (let index = 0; index < args.length; index++) {
    const option = args[index];
    if (option === "--execute") {
      if (execute) throw new Error("Duplicate option: --execute");
      execute = true;
      continue;
    }
    if (!["--database", "--sqlite", "--expected-revision"].includes(option)) {
      throw new Error(`Unknown option: ${option}`);
    }
    if (values.has(option)) throw new Error(`Duplicate option: ${option}`);
    const value = args[++index];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    values.set(option, value);
  }
  const target = databaseTarget(values.get("--database"), values.get("--sqlite"));
  const revision = values.get("--expected-revision");
  if (action === "status") {
    if (execute || revision !== undefined) {
      throw new Error("status does not accept --execute or --expected-revision");
    }
    return { ...target, action, execute };
  }
  if (revision === undefined || !/^(0|[1-9][0-9]*)$/.test(revision)) {
    throw new Error("freeze/unfreeze require --expected-revision <nonnegative integer>");
  }
  const expectedRevision = Number(revision);
  if (!Number.isSafeInteger(expectedRevision)) throw new Error("Unsafe expected revision");
  return { ...target, action, expectedRevision, execute };
}

export function buildMaintenanceSql(input: {
  action: Action;
  expectedRevision?: number;
  auditId: string;
  now: number;
  before?: StoredAdmissionPolicy;
}): { preflight: string; execution: readonly string[] } {
  const columns =
    "schema_version, revision, rules_json, writes_frozen, updated_at, updated_by_user_id_snapshot";
  if (input.action === "status") {
    return {
      preflight: `SELECT 'preflight' AS report, 'status' AS status,
        ${columns} FROM workspace_admission_policy WHERE id = 1;`,
      execution: [],
    };
  }
  if (
    input.expectedRevision === undefined ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 0
  ) {
    throw new Error("freeze/unfreeze require a safe nonnegative expected revision");
  }
  const revision = sqlLiteral(input.expectedRevision);
  const frozen = input.action === "freeze" ? 1 : 0;
  const auditId = sqlLiteral(input.auditId);
  const requestId = sqlLiteral(`operator-cli:${input.auditId}`);
  const now = sqlLiteral(input.now);
  const preflight = `SELECT 'preflight' AS report, CASE
      WHEN revision <> ${revision} THEN 'conflict'
      WHEN writes_frozen = ${frozen} THEN 'no-op'
      WHEN revision = ${Number.MAX_SAFE_INTEGER} THEN 'refused'
      ELSE 'ready' END AS status, ${columns}
      FROM workspace_admission_policy WHERE id = 1;`;
  // The first read is validated by the shared parser before mutation SQL can be constructed.
  if (!input.before) return { preflight, execution: [] };
  const before = input.before;
  const documentMatch = `id = 1 AND schema_version = 1 AND rules_json = ${sqlLiteral(before.rulesJson)}`;
  const metadataMatch = `updated_at IS ${before.updatedAt === null ? "NULL" : sqlLiteral(before.updatedAt)}
    AND updated_by_user_id_snapshot IS ${before.updatedByUserId === null ? "NULL" : sqlLiteral(before.updatedByUserId)}`;
  const ready = `${documentMatch} AND revision = ${revision} AND revision = ${sqlLiteral(before.revision)}
    AND writes_frozen = ${before.writesFrozen ? 1 : 0} AND ${metadataMatch}
    AND (writes_frozen = ${frozen} OR revision < ${Number.MAX_SAFE_INTEGER})`;
  const exactAudit = `EXISTS (
    SELECT 1 FROM authorization_audit_events
    WHERE id = ${auditId} AND occurred_at = ${now} AND request_id = ${requestId}
      AND principal_kind = 'service' AND actor_user_id_snapshot IS NULL
      AND actor_service_snapshot = 'operator-cli'
      AND action = 'workspace.admission_policy_maintenance'
      AND resource_type = 'admission_policy' AND resource_id = 'workspace'
      AND target_user_id_snapshot IS NULL AND reason_code = 'operator_cli'
      AND json_extract(metadata_json, '$.before.revision') = ${revision}
      AND json_extract(metadata_json, '$.requested.writesFrozen') = ${frozen}
      AND json_extract(metadata_json, '$.after.revision') = workspace_admission_policy.revision
      AND json_extract(metadata_json, '$.after.writesFrozen') = workspace_admission_policy.writes_frozen
      AND ((operation_result = 'applied'
        AND json_extract(metadata_json, '$.before.writesFrozen') <> ${frozen}
        AND workspace_admission_policy.revision = ${revision} + 1
        AND workspace_admission_policy.updated_at = ${now}
        AND workspace_admission_policy.updated_by_user_id_snapshot IS NULL)
        OR (operation_result = 'no_op'
          AND json_extract(metadata_json, '$.before.writesFrozen') = ${frozen}
          AND workspace_admission_policy.revision = ${revision} AND ${metadataMatch}))
  )`;
  return {
    preflight,
    execution: [
      `INSERT INTO authorization_audit_events
        (id, occurred_at, request_id, principal_kind, actor_service_snapshot,
         action, resource_type, resource_id, reason_code, operation_result, metadata_json)
       SELECT ${auditId}, ${now}, ${requestId}, 'service', 'operator-cli',
         'workspace.admission_policy_maintenance', 'admission_policy', 'workspace', 'operator_cli',
         CASE WHEN writes_frozen = ${frozen} THEN 'no_op' ELSE 'applied' END,
         json_object(
           'before', json_object('revision', revision, 'writesFrozen', writes_frozen),
           'requested', json_object('expectedRevision', ${revision}, 'writesFrozen', ${frozen}),
           'after', json_object('revision', revision + CASE WHEN writes_frozen = ${frozen} THEN 0 ELSE 1 END,
             'writesFrozen', ${frozen})
         )
       FROM workspace_admission_policy WHERE ${ready};`,
      `UPDATE workspace_admission_policy
       SET writes_frozen = ${frozen}, revision = revision + 1, updated_at = ${now},
         updated_by_user_id_snapshot = NULL
        WHERE ${ready} AND writes_frozen <> ${frozen}
         AND EXISTS (SELECT 1 FROM authorization_audit_events
           WHERE id = ${auditId} AND request_id = ${requestId} AND operation_result = 'applied');`,
      // A broken postcondition after an audit must abort SQL, not fail after commit.
      // SQLite/D1 both raise on malformed JSON; CASE keeps this error branch lazy.
      `SELECT 'postcondition' AS report, CASE
        WHEN NOT (${documentMatch}) THEN 'refused'
        WHEN ${exactAudit} THEN CASE WHEN revision = ${revision} THEN 'no-op' ELSE 'executed' END
        WHEN revision <> ${revision} THEN 'conflict'
        ELSE 'refused' END AS status,
        CASE WHEN EXISTS (SELECT 1 FROM authorization_audit_events WHERE id = ${auditId})
          THEN CASE WHEN (${documentMatch}) AND (${exactAudit}) THEN 1
            ELSE json('admission policy postcondition failed') END
          ELSE 0 END AS audit_written, ${columns}
       FROM workspace_admission_policy WHERE id = 1;`,
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readReport(output: string, count: number, report: string): Record<string, unknown> {
  const results: unknown = JSON.parse(output);
  if (
    !Array.isArray(results) ||
    results.length !== count ||
    !results.every(
      (result) => isRecord(result) && result.success === true && Array.isArray(result.results)
    )
  ) {
    throw new Error("Malformed SQL transaction result; do not automatically retry changes");
  }
  const rows: unknown = results.at(-1).results;
  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !isRecord(rows[0]) ||
    rows[0].report !== report
  ) {
    throw new Error("Missing admission policy singleton or transaction report");
  }
  const row = rows[0];
  try {
    parseStoredAdmissionPolicy(row);
  } catch {
    throw new Error("Invalid admission policy snapshot; operation refused");
  }
  return row;
}

export async function run(
  options: MaintenanceOptions,
  dependencies: { runWrangler?: WranglerRunner; randomUUID?: () => string; now?: () => number } = {}
): Promise<Record<string, unknown>> {
  const target = databaseTarget(options.database, options.sqlite);
  if (options.action === "status" && (options.execute || options.expectedRevision !== undefined)) {
    throw new Error("status does not accept --execute or --expected-revision");
  }
  const input = {
    ...options,
    auditId: dependencies.randomUUID?.() ?? crypto.randomUUID(),
    now: dependencies.now?.() ?? Date.now(),
  };
  const sql = buildMaintenanceSql(input);
  const write = options.execute && options.action !== "status";
  let row = readReport(
    runSql(target, [sql.preflight], false, dependencies.runWrangler),
    1,
    "preflight"
  );
  if (write && (row.status === "ready" || row.status === "no-op")) {
    // Bind the exact validated document as well as its revision. A concurrent restore must not
    // let invalid rules through, even if it failed to advance the revision.
    const statements = buildMaintenanceSql({
      ...input,
      before: parseStoredAdmissionPolicy(row),
    }).execution;
    // Freeze and its exported snapshot still come from the same mutation transaction.
    row = readReport(
      runSql(target, statements, true, dependencies.runWrangler),
      statements.length,
      "postcondition"
    );
  }
  if (row.status === "conflict") {
    throw new Error(
      `Expected revision is stale (current revision: ${row.revision}); inspect status before retrying`
    );
  }
  const allowed = write
    ? ["executed", "no-op"]
    : options.action === "status"
      ? ["status"]
      : ["ready", "no-op"];
  if (!allowed.includes(String(row.status)) || (write && row.audit_written !== 1)) {
    throw new Error(
      "Admission policy maintenance refused or did not prove its exact audit and state"
    );
  }
  const managed: unknown = JSON.parse(row.rules_json as string);
  const snapshot = {
    action: options.action,
    status: row.status,
    dryRun: !write && options.action !== "status",
    schemaVersion: row.schema_version,
    revision: row.revision,
    writesFrozen: row.writes_frozen === 1,
    managed,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id_snapshot,
  };
  console.log(JSON.stringify(snapshot));
  console.error(
    "Managed rules only: the deployed admission baseline is not stored in this database. For rollback, export while frozen and union those rules with the actual deployed baseline. Keep deployments stopped and the baseline stable separately; this tool does not serialize deployments."
  );
  if (!write && options.action !== "status") {
    console.error(
      "Dry run only. Re-run with --execute and the reviewed --expected-revision to change state."
    );
  }
  return snapshot;
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
