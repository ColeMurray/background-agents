import type {
  ModelProviderAccountDefault,
  ProviderAuthMode,
} from "@open-inspect/shared/types/provider-accounts";
import {
  assertModelProviderId,
  type ModelProviderId,
} from "../model-provider-accounts/provider-auth-contracts";
import type { SqlDatabase, SqlStatement } from "./sql-database";

export type ProviderUnattendedMode = ProviderAuthMode;
export type ProviderDefault = ModelProviderAccountDefault;

interface DefaultRow {
  configured: number;
  selection_mode: string;
  provider: string;
  provider_account_id: string;
  unattended_mode: ProviderUnattendedMode;
  created_by: string | null;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
}

function toDefault(row: DefaultRow): ProviderDefault {
  if (row.selection_mode !== "fixed") throw new ProviderDefaultUpgradeRequiredError();
  assertModelProviderId(row.provider);
  return {
    provider: row.provider,
    providerAccountId: row.provider_account_id,
    unattendedMode: row.unattended_mode,
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class ProviderDefaultConstraintError extends Error {}
export class ProviderDefaultUpgradeRequiredError extends ProviderDefaultConstraintError {
  constructor() {
    super("provider_routing_upgrade_required: use provider account routing");
  }
}

export class ProviderDefaultStore {
  constructor(private readonly db: SqlDatabase) {}

  async set(
    provider: ModelProviderId,
    providerAccountId: string,
    unattendedMode: ProviderUnattendedMode,
    actorId: string | null,
    now = Date.now()
  ): Promise<void> {
    assertModelProviderId(provider);
    const result = await this.db
      .prepare(
        `INSERT INTO model_provider_account_defaults (
           provider, provider_account_id, unattended_mode, created_by, updated_by, created_at, updated_at
         )
         SELECT ?, id, ?, ?, ?, ?, ? FROM model_provider_accounts
         WHERE id = ? AND provider = ? AND status = 'active' AND archived_at IS NULL
         ON CONFLICT(provider) DO UPDATE SET
           provider_account_id = excluded.provider_account_id,
           unattended_mode = excluded.unattended_mode,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at,
           configured = 1,
           selection_mode = 'fixed',
           policy_revision = model_provider_account_defaults.policy_revision + 1
         WHERE model_provider_account_defaults.configured = 0 OR model_provider_account_defaults.selection_mode = 'fixed'`
      )
      .bind(provider, unattendedMode, actorId, actorId, now, now, providerAccountId, provider)
      .run();
    if (result.meta.changes === 0) {
      await this.get(provider);
      throw new ProviderDefaultConstraintError(`Default requires an active ${provider} account`);
    }
  }

  bindSetForFirstActiveAccount(
    accountId: string,
    provider: ModelProviderId,
    actorId: string,
    now: number
  ): SqlStatement {
    assertModelProviderId(provider);
    return this.db
      .prepare(
        `INSERT INTO model_provider_account_defaults
          (provider, provider_account_id, unattended_mode, created_by, updated_by,
           created_at, updated_at)
         SELECT ?, id, 'provider_account', ?, ?, ?, ?
         FROM model_provider_accounts
         WHERE id = ? AND provider = ? AND status = 'active' AND archived_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM model_provider_account_defaults WHERE provider = ? AND configured = 1
           )
           AND NOT EXISTS (
             SELECT 1 FROM model_provider_accounts
             WHERE provider = ? AND status = 'active' AND archived_at IS NULL AND id <> ?
           )
         ON CONFLICT(provider) DO UPDATE SET
           provider_account_id = excluded.provider_account_id, unattended_mode = excluded.unattended_mode,
           configured = 1, selection_mode = 'fixed', policy_revision = model_provider_account_defaults.policy_revision + 1,
           updated_by = excluded.updated_by, updated_at = excluded.updated_at
         WHERE model_provider_account_defaults.configured = 0`
      )
      .bind(
        provider,
        actorId,
        actorId,
        now,
        now,
        accountId,
        provider,
        provider,
        provider,
        accountId
      );
  }

  async get(provider: ModelProviderId): Promise<ProviderDefault | null> {
    assertModelProviderId(provider);
    const row = await this.db
      .prepare("SELECT * FROM model_provider_account_defaults WHERE provider = ?")
      .bind(provider)
      .first<DefaultRow>();
    return row?.configured ? toDefault(row) : null;
  }

  async list(): Promise<ProviderDefault[]> {
    const rows = await this.db
      .prepare(
        "SELECT * FROM model_provider_account_defaults WHERE configured = 1 ORDER BY provider"
      )
      .all<DefaultRow>();
    return rows.results.map(toDefault);
  }

  async remove(provider: ModelProviderId): Promise<boolean> {
    assertModelProviderId(provider);
    await this.get(provider);
    const result = await this.db
      .prepare(
        "UPDATE model_provider_account_defaults SET configured = 0, provider_account_id = NULL, policy_revision = policy_revision + 1 WHERE provider = ? AND configured = 1 AND selection_mode = 'fixed'"
      )
      .bind(provider)
      .run();
    if (result.meta.changes === 0) await this.get(provider);
    return result.meta.changes > 0;
  }
}
