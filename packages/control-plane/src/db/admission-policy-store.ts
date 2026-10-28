import { admissionRulesSchema, type AdmissionRules } from "@open-inspect/shared/admission-settings";
import { BUILT_IN_ROLE_REGISTRY } from "@open-inspect/shared/rbac";
import { z } from "zod";
import type { SqlDatabase } from "./sql-database";

const rowSchema = z.object({
  schema_version: z.literal(1),
  revision: z.number().int().nonnegative().safe(),
  rules_json: z.string(),
  updated_at: z.number().int().nonnegative().safe().nullable(),
  updated_by_user_id_snapshot: z.string().min(1).nullable(),
  writes_frozen: z.union([z.literal(0), z.literal(1)]),
});

export interface StoredAdmissionPolicy {
  rules: AdmissionRules;
  revision: number;
  updatedAt: number | null;
  updatedByUserId: string | null;
  writesFrozen: boolean;
}

function parseRow(value: unknown): StoredAdmissionPolicy {
  const row = rowSchema.parse(value);
  return {
    rules: admissionRulesSchema.parse(JSON.parse(row.rules_json)),
    revision: row.revision,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id_snapshot,
    writesFrozen: row.writes_frozen === 1,
  };
}

const mutationStatusSchema = z.enum([
  "applied",
  "no_op",
  "actor_authorization_changed",
  "conflict",
  "maintenance",
  "unavailable",
]);

/** Authoritative singleton reads and audit-guarded, atomic whole-document replacement. */
export class AdmissionPolicyStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(): Promise<StoredAdmissionPolicy> {
    return parseRow(
      await this.db.prepare("SELECT * FROM workspace_admission_policy WHERE id = 1").first()
    );
  }

  async replace(input: {
    expectedRevision: number;
    rules: AdmissionRules;
    actorUserId: string;
    requestId: string;
    now: number;
    deploymentHash: string;
  }): Promise<{ status: z.infer<typeof mutationStatusSchema>; policy: StoredAdmissionPolicy }> {
    const rules = admissionRulesSchema.parse(input.rules);
    const raw = rowSchema.parse(
      await this.db.prepare("SELECT * FROM workspace_admission_policy WHERE id = 1").first()
    );
    const before = parseRow(raw);
    const unchanged = JSON.stringify(before.rules) === JSON.stringify(rules);
    const auditId = crypto.randomUUID();
    // The decision and historical snapshot are captured before the update in the same transaction.
    // Comparing the validated document as well as revision prevents malformed out-of-band state
    // from being silently repaired by a management write.
    const results = await this.db.batch([
      this.db
        .prepare(
          `
        WITH decision(status) AS (SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1 FROM users u
            JOIN user_role_assignments assignment ON assignment.user_id = u.id
            JOIN roles r ON r.id = assignment.role_id
            WHERE u.id = ? AND u.suspended_at IS NULL AND r.is_system = 1 AND
              ((r.id = ? AND r.key = 'owner') OR (r.id = ? AND r.key = 'administrator'))
          ) THEN 'actor_authorization_changed'
          WHEN NOT EXISTS (SELECT 1 FROM workspace_admission_policy WHERE id = 1 AND schema_version = 1)
            THEN 'unavailable'
          WHEN (SELECT writes_frozen FROM workspace_admission_policy WHERE id = 1) <> 0
            THEN 'maintenance'
          WHEN NOT EXISTS (SELECT 1 FROM workspace_admission_policy
            WHERE id = 1 AND revision = ? AND revision = ? AND rules_json = ?)
            THEN 'conflict'
          WHEN ? THEN 'no_op'
          ELSE 'applied' END)
        INSERT INTO authorization_audit_events
          (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot,
           action, resource_type, resource_id, reason_code, operation_result, metadata_json)
        SELECT ?, ?, ?, 'user', ?, 'workspace.admission_policy_updated', 'admission_policy', 'workspace',
          status,
          CASE status WHEN 'applied' THEN 'applied' WHEN 'no_op' THEN 'no_op'
            WHEN 'actor_authorization_changed' THEN 'denied' ELSE 'rejected' END,
          json_object(
            'requested', json_object('expectedRevision', ?),
            'currentRevision', (SELECT revision FROM workspace_admission_policy WHERE id = 1),
            'resultRevision', (SELECT revision FROM workspace_admission_policy WHERE id = 1)
              + CASE WHEN status = 'applied' THEN 1 ELSE 0 END,
            'deploymentHash', ?,
            'before', json((SELECT rules_json FROM workspace_admission_policy WHERE id = 1)),
            'after', json(CASE WHEN status = 'applied' THEN ?
              ELSE (SELECT rules_json FROM workspace_admission_policy WHERE id = 1) END)
          )
        FROM decision RETURNING reason_code AS status
      `
        )
        .bind(
          input.actorUserId,
          BUILT_IN_ROLE_REGISTRY.owner.id,
          BUILT_IN_ROLE_REGISTRY.administrator.id,
          input.expectedRevision,
          before.revision,
          raw.rules_json,
          unchanged ? 1 : 0,
          auditId,
          input.now,
          input.requestId,
          input.actorUserId,
          input.expectedRevision,
          input.deploymentHash,
          JSON.stringify(rules)
        ),
      this.db
        .prepare(
          `UPDATE workspace_admission_policy
        SET rules_json = ?, revision = revision + 1, updated_at = ?, updated_by_user_id_snapshot = ?
        WHERE id = 1 AND EXISTS (
          SELECT 1 FROM authorization_audit_events WHERE id = ? AND operation_result = 'applied'
        )`
        )
        .bind(JSON.stringify(rules), input.now, input.actorUserId, auditId),
      this.db.prepare("SELECT * FROM workspace_admission_policy WHERE id = 1"),
    ]);
    const status = mutationStatusSchema.parse(
      (results[0].results[0] as { status?: unknown })?.status
    );
    return { status, policy: parseRow(results[2].results[0]) };
  }
}
