import {
  SUBSCRIPTION_PROVIDER_IDS,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import {
  providerAccountRoutingRequestSchema,
  type ProviderAccountRouting,
  type ProviderAccountRoutingRequest,
} from "@open-inspect/shared/types/provider-account-routing";
import type { SqlDatabase } from "./sql-database";

export class ProviderRoutingConflictError extends Error {}
interface RoutingRow {
  provider: SubscriptionProviderId;
  provider_account_id: string | null;
  unattended_mode: "api_key" | "provider_account";
  selection_mode: "fixed" | "random";
  configured: number;
  policy_revision: number;
}

/** Policy and membership mutations share a winning mutation token, not changes(). */
export class ProviderAccountRoutingStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(provider: SubscriptionProviderId): Promise<ProviderAccountRouting> {
    // One batch snapshot prevents reading membership from a different policy revision.
    const [rows, members] = await this.db.batch<RoutingRow | { provider_account_id: string }>([
      this.db
        .prepare("SELECT * FROM model_provider_account_defaults WHERE provider = ?")
        .bind(provider),
      this.db
        .prepare(
          "SELECT provider_account_id FROM model_provider_account_policy_members WHERE provider = ? ORDER BY provider_account_id"
        )
        .bind(provider),
    ]);
    const row = rows.results[0] as RoutingRow | undefined;
    return {
      provider,
      policyRevision: row?.policy_revision ?? 0,
      unattendedMode: row?.unattended_mode ?? "provider_account",
      selection: !row?.configured
        ? { mode: "unconfigured" }
        : row.selection_mode === "fixed"
          ? { mode: "fixed", accountId: row.provider_account_id! }
          : {
              mode: "random",
              accountIds: members.results.map((member) => member.provider_account_id!),
            },
    };
  }

  async list(): Promise<ProviderAccountRouting[]> {
    return Promise.all(SUBSCRIPTION_PROVIDER_IDS.map((provider) => this.get(provider)));
  }

  async set(
    provider: SubscriptionProviderId,
    raw: ProviderAccountRoutingRequest,
    actorId: string | null,
    now = Date.now()
  ): Promise<ProviderAccountRouting> {
    const input = providerAccountRoutingRequestSchema.parse(raw);
    const ids =
      input.selection.mode === "random"
        ? input.selection.accountIds
        : input.selection.mode === "fixed"
          ? [input.selection.accountId]
          : [];
    const token = crypto.randomUUID();
    const eligibility = ids.length
      ? `AND (SELECT COUNT(*) FROM model_provider_accounts WHERE provider = ? AND id IN (${ids.map(() => "?").join(",")}) AND status = 'active' AND archived_at IS NULL) = ?`
      : "";
    const eligibleValues = ids.length ? [provider, ...ids, ids.length] : [];
    const result = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO model_provider_account_defaults
        (provider, provider_account_id, unattended_mode, selection_mode, configured, policy_revision, mutation_id, created_by, updated_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ? WHERE ? = 0 ${eligibility}
        ON CONFLICT(provider) DO NOTHING`
        )
        .bind(
          provider,
          input.selection.mode === "fixed" ? input.selection.accountId : null,
          input.unattendedMode,
          input.selection.mode === "random" ? "random" : "fixed",
          input.selection.mode === "unconfigured" ? 0 : 1,
          token,
          actorId,
          actorId,
          now,
          now,
          input.expectedPolicyRevision,
          ...eligibleValues
        ),
      this.db
        .prepare(
          `UPDATE model_provider_account_defaults SET provider_account_id = ?, unattended_mode = ?,
        selection_mode = ?, configured = ?, policy_revision = policy_revision + 1, mutation_id = ?, updated_by = ?, updated_at = ?
        WHERE provider = ? AND policy_revision = ? AND ? > 0 ${eligibility}`
        )
        .bind(
          input.selection.mode === "fixed" ? input.selection.accountId : null,
          input.unattendedMode,
          input.selection.mode === "random" ? "random" : "fixed",
          input.selection.mode === "unconfigured" ? 0 : 1,
          token,
          actorId,
          now,
          provider,
          input.expectedPolicyRevision,
          input.expectedPolicyRevision,
          ...eligibleValues
        ),
      this.db
        .prepare(
          `DELETE FROM model_provider_account_policy_members WHERE provider = ? AND EXISTS
        (SELECT 1 FROM model_provider_account_defaults WHERE provider = ? AND mutation_id = ?)`
        )
        .bind(provider, provider, token),
      ...(input.selection.mode === "random"
        ? ids.map((id) =>
            this.db
              .prepare(
                `INSERT INTO model_provider_account_policy_members (provider, provider_account_id)
        SELECT provider, ? FROM model_provider_account_defaults WHERE provider = ? AND mutation_id = ?`
              )
              .bind(id, provider, token)
          )
        : []),
      this.db
        .prepare(
          `INSERT INTO model_provider_account_policy_audit (mutation_id, provider, policy_revision, actor_id, created_at)
        SELECT mutation_id, provider, policy_revision, ?, ? FROM model_provider_account_defaults WHERE provider = ? AND mutation_id = ?`
        )
        .bind(actorId, now, provider, token),
    ]);
    if (result[0].meta.changes + result[1].meta.changes !== 1) {
      throw new ProviderRoutingConflictError(
        "Routing policy changed or selected accounts are unavailable"
      );
    }
    return this.get(provider);
  }
}
