/**
 * The workspace's personal access token policy: a single row, replaced whole under a revision
 * compare-and-set, with its audit event written in the same transaction as the change.
 */

import { PERMISSION_IDS } from "@open-inspect/shared/rbac";
import {
  personalAccessTokenPolicySchema,
  type PersonalAccessTokenPolicy,
  type PersonalAccessTokenPolicySnapshot,
} from "@open-inspect/shared/types/personal-access-tokens";
import type { SqlDatabase } from "./sql-database";

interface PolicyRow {
  enabled: number;
  max_lifetime_days: number | null;
  allowed_permissions_json: string | null;
  revision: number;
  updated_at: number | null;
  updated_by_user_id_snapshot: string | null;
}

/**
 * Registered permissions in registry order. A stored ceiling naming a permission since removed
 * from the registry keeps the rest, rather than failing every token's authentication.
 */
function storedCeiling(json: string | null): PersonalAccessTokenPolicy["allowedPermissions"] {
  if (json === null) return null;
  const parsed: unknown = JSON.parse(json);
  if (!Array.isArray(parsed)) throw new Error("Stored token permission ceiling is not a list");
  const named = new Set(parsed.filter((value): value is string => typeof value === "string"));
  return PERMISSION_IDS.filter((permission) => named.has(permission));
}

function toSnapshot(row: PolicyRow): PersonalAccessTokenPolicySnapshot {
  return {
    enabled: row.enabled === 1,
    maxLifetimeDays: row.max_lifetime_days,
    allowedPermissions: storedCeiling(row.allowed_permissions_json),
    revision: row.revision,
    updatedAt: row.updated_at,
    updatedByUserId: row.updated_by_user_id_snapshot,
  };
}

function rulesOf(policy: PersonalAccessTokenPolicy): PersonalAccessTokenPolicy {
  return {
    enabled: policy.enabled,
    maxLifetimeDays: policy.maxLifetimeDays,
    allowedPermissions: policy.allowedPermissions,
  };
}

export type ReplacePersonalAccessTokenPolicyResult =
  | { status: "applied"; policy: PersonalAccessTokenPolicySnapshot }
  | { status: "conflict"; policy: PersonalAccessTokenPolicySnapshot };

export class PersonalAccessTokenPolicyStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(): Promise<PersonalAccessTokenPolicySnapshot> {
    const row = await this.db
      .prepare(
        `SELECT enabled, max_lifetime_days, allowed_permissions_json, revision, updated_at,
                updated_by_user_id_snapshot
           FROM workspace_personal_access_token_policy WHERE id = 1`
      )
      .first<PolicyRow>();
    if (!row) throw new Error("Personal access token policy row is missing");
    return toSnapshot(row);
  }

  /**
   * Replace the policy if it is still at `expectedRevision`. The audit insert and the update share
   * one precondition inside one transaction, so the event is written exactly when the change is.
   */
  async replace(input: {
    before: PersonalAccessTokenPolicySnapshot;
    expectedRevision: number;
    policy: PersonalAccessTokenPolicy;
    actorUserId: string;
    requestId: string;
    now: number;
  }): Promise<ReplacePersonalAccessTokenPolicyResult> {
    const after = personalAccessTokenPolicySchema.parse(input.policy);
    const ceiling =
      after.allowedPermissions === null
        ? null
        : JSON.stringify(PERMISSION_IDS.filter((p) => after.allowedPermissions!.includes(p)));
    const [, updated] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO authorization_audit_events
             (id, occurred_at, request_id, principal_kind, actor_user_id_snapshot, action,
              resource_type, resource_id, reason_code, operation_result, metadata_json)
           SELECT ?, ?, ?, 'user', ?, 'workspace.personal_access_token_policy_updated',
                  'personal_access_token_policy', 'workspace',
                  'workspace.personal_access_token_policy_updated', 'applied', ?
           WHERE EXISTS (
             SELECT 1 FROM workspace_personal_access_token_policy WHERE id = 1 AND revision = ?
           )`
        )
        .bind(
          crypto.randomUUID(),
          input.now,
          input.requestId,
          input.actorUserId,
          JSON.stringify({
            before: rulesOf(input.before),
            requested: { expectedRevision: input.expectedRevision },
            after,
          }),
          input.expectedRevision
        ),
      this.db
        .prepare(
          `UPDATE workspace_personal_access_token_policy
              SET enabled = ?, max_lifetime_days = ?, allowed_permissions_json = ?,
                  revision = revision + 1, updated_at = ?, updated_by_user_id_snapshot = ?
            WHERE id = 1 AND revision = ?`
        )
        .bind(
          after.enabled ? 1 : 0,
          after.maxLifetimeDays,
          ceiling,
          input.now,
          input.actorUserId,
          input.expectedRevision
        ),
    ]);
    const policy = await this.get();
    return { status: updated.meta.changes === 1 ? "applied" : "conflict", policy };
  }
}
