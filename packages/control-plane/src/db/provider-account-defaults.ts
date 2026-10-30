import {
  PROVIDER_ACCOUNT_POOL_MAX_SIZE,
  providerAuthModeSchema,
  subscriptionProviderIdSchema,
  SUBSCRIPTION_PROVIDER_IDS,
  type ModelProviderAccountDefault,
  type ProviderAccountRouting,
  type ProviderAccountRoutingRequest,
  type ProviderAuthMode,
} from "@open-inspect/shared/types/provider-accounts";
import {
  assertModelProviderId,
  type ModelProviderId,
} from "../model-provider-accounts/provider-auth-contracts";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { z } from "zod";

export type ProviderUnattendedMode = ProviderAuthMode;
export type ProviderDefault = ModelProviderAccountDefault;

const auditUserIdSchema = z.string().min(1).nullable();
const timestampMsSchema = z.number().int().nonnegative();

const providerDefaultRowSchema = z.object({
  provider: subscriptionProviderIdSchema,
  provider_account_id: z.string().min(1),
  unattended_mode: providerAuthModeSchema,
  created_by: auditUserIdSchema,
  updated_by: auditUserIdSchema,
  created_at: timestampMsSchema,
  updated_at: timestampMsSchema,
});

const providerDefaultWriteSchema = z.object({
  actorId: auditUserIdSchema,
  now: timestampMsSchema,
});

type DefaultRow = z.infer<typeof providerDefaultRowSchema>;

function parseDefaultRow(row: unknown): DefaultRow {
  const parsed = providerDefaultRowSchema.safeParse(row);
  if (parsed.success) return parsed.data;
  throw new Error("Invalid provider default row");
}

function assertValidDefaultWrite(actorId: string | null, now: number): void {
  const parsed = providerDefaultWriteSchema.safeParse({ actorId, now });
  if (!parsed.success) throw new Error("Invalid provider default write");
}

function toDefault(row: DefaultRow): ProviderDefault {
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

export class ProviderDefaultStore {
  constructor(private readonly db: SqlDatabase) {}

  /**
   * Store a fixed default and drop that provider's pool members in one batch.
   * The delete uses the same active-account predicate as the upsert, so a
   * rejected write leaves an existing random pool in place.
   */
  async set(
    provider: ModelProviderId,
    providerAccountId: string,
    unattendedMode: ProviderUnattendedMode,
    actorId: string | null,
    now = Date.now()
  ): Promise<void> {
    assertModelProviderId(provider);
    assertValidDefaultWrite(actorId, now);
    const [result] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO model_provider_account_defaults (
           provider, provider_account_id, unattended_mode, selection_mode, write_token,
           created_by, updated_by, created_at, updated_at
         )
         SELECT ?, id, ?, 'fixed', NULL, ?, ?, ?, ? FROM model_provider_accounts
         WHERE id = ? AND provider = ? AND status = 'active' AND archived_at IS NULL
         ON CONFLICT(provider) DO UPDATE SET
           provider_account_id = excluded.provider_account_id,
           unattended_mode = excluded.unattended_mode,
           selection_mode = 'fixed',
           write_token = NULL,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at`
        )
        .bind(provider, unattendedMode, actorId, actorId, now, now, providerAccountId, provider),
      this.db
        .prepare(
          `DELETE FROM model_provider_account_pool_members
           WHERE provider = ?
             AND EXISTS (
               SELECT 1 FROM model_provider_account_defaults
               WHERE provider = ? AND selection_mode = 'fixed'
             )
             AND EXISTS (
               SELECT 1 FROM model_provider_accounts
               WHERE id = ? AND provider = ? AND status = 'active' AND archived_at IS NULL
             )`
        )
        .bind(provider, provider, providerAccountId, provider),
    ]);
    if (result.meta.changes === 0) {
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
    assertValidDefaultWrite(actorId, now);
    return this.db
      .prepare(
        `INSERT INTO model_provider_account_defaults
          (provider, provider_account_id, unattended_mode, selection_mode, write_token,
           created_by, updated_by, created_at, updated_at)
         SELECT ?, id, 'provider_account', 'fixed', NULL, ?, ?, ?, ?
         FROM model_provider_accounts
         WHERE id = ? AND provider = ? AND status = 'active' AND archived_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM model_provider_account_defaults WHERE provider = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM model_provider_accounts
             WHERE provider = ? AND status = 'active' AND archived_at IS NULL AND id <> ?
           )
         ON CONFLICT(provider) DO NOTHING`
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
      .prepare(
        `SELECT * FROM model_provider_account_defaults
         WHERE provider = ? AND selection_mode = 'fixed'`
      )
      .bind(provider)
      .first<unknown>();
    return row ? toDefault(parseDefaultRow(row)) : null;
  }

  async list(): Promise<ProviderDefault[]> {
    const rows = await this.db
      .prepare(
        `SELECT * FROM model_provider_account_defaults
         WHERE selection_mode = 'fixed' ORDER BY provider`
      )
      .all<unknown>();
    return rows.results.map((row) => toDefault(parseDefaultRow(row)));
  }

  async remove(provider: ModelProviderId): Promise<boolean> {
    assertModelProviderId(provider);
    const [members, defaults] = await this.db.batch([
      this.db
        .prepare("DELETE FROM model_provider_account_pool_members WHERE provider = ?")
        .bind(provider),
      this.db
        .prepare("DELETE FROM model_provider_account_defaults WHERE provider = ?")
        .bind(provider),
    ]);
    return members.meta.changes + defaults.meta.changes > 0;
  }

  async getRouting(provider: ModelProviderId): Promise<ProviderAccountRouting> {
    assertModelProviderId(provider);
    const row = await this.db
      .prepare("SELECT * FROM model_provider_account_defaults WHERE provider = ?")
      .bind(provider)
      .first<unknown>();
    if (!row) return unconfiguredRouting(provider);
    const parsed = providerRoutingRowSchema.safeParse(row);
    if (!parsed.success) throw new Error("Invalid provider routing row");
    if (parsed.data.selection_mode === "fixed") {
      if (!parsed.data.provider_account_id) throw new Error("Invalid provider routing row");
      return {
        provider,
        unattendedMode: parsed.data.unattended_mode,
        selection: { mode: "fixed", accountId: parsed.data.provider_account_id },
      };
    }
    const members = await this.db
      .prepare(
        `SELECT provider_account_id FROM model_provider_account_pool_members
         WHERE provider = ? ORDER BY provider_account_id`
      )
      .bind(provider)
      .all<{ provider_account_id: string }>();
    return {
      provider,
      unattendedMode: parsed.data.unattended_mode,
      selection: {
        mode: "random",
        accountIds: members.results.map((member) => member.provider_account_id),
      },
    };
  }

  async listRouting(): Promise<ProviderAccountRouting[]> {
    return Promise.all(SUBSCRIPTION_PROVIDER_IDS.map((provider) => this.getRouting(provider)));
  }

  /**
   * Replace a provider's fixed default or random pool. Random membership is
   * written only when every id is an active account, in one batch, and only
   * while random allocation is enabled. The pool is capped so the statement
   * stays under D1's parameter limit.
   */
  async setRouting(
    provider: ModelProviderId,
    input: ProviderAccountRoutingRequest,
    actorId: string | null,
    now: number,
    randomEnabled: boolean
  ): Promise<ProviderAccountRouting> {
    assertModelProviderId(provider);
    assertValidDefaultWrite(actorId, now);
    if (input.selection.mode === "unconfigured") {
      await this.remove(provider);
      return this.getRouting(provider);
    }
    if (input.selection.mode === "fixed") {
      await this.set(provider, input.selection.accountId, input.unattendedMode, actorId, now);
      return this.getRouting(provider);
    }
    if (!randomEnabled) {
      throw new ProviderDefaultConstraintError("Random provider allocation is not enabled");
    }
    const ids = [...input.selection.accountIds].sort();
    if (new Set(ids).size !== ids.length) {
      throw new ProviderDefaultConstraintError("Random pool contains duplicate accounts");
    }
    if (ids.length === 0 || ids.length > PROVIDER_ACCOUNT_POOL_MAX_SIZE) {
      throw new ProviderDefaultConstraintError("Random pool size is outside the supported range");
    }
    const token = crypto.randomUUID();
    const placeholders = ids.map(() => "?").join(", ");
    const eligibility = `(SELECT COUNT(*) FROM model_provider_accounts
         WHERE provider = ? AND id IN (${placeholders}) AND status = 'active' AND archived_at IS NULL) = ?`;
    const eligible = [provider, ...ids, ids.length];
    const [written, , inserted] = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO model_provider_account_defaults (
             provider, provider_account_id, unattended_mode, selection_mode, write_token,
             created_by, updated_by, created_at, updated_at
           )
           SELECT ?, ?, ?, 'random', ?, ?, ?, ?, ?
           WHERE ${eligibility}
           ON CONFLICT(provider) DO UPDATE SET
             provider_account_id = excluded.provider_account_id,
             unattended_mode = excluded.unattended_mode,
             selection_mode = 'random',
             write_token = excluded.write_token,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at
           WHERE ${eligibility}`
        )
        .bind(
          provider,
          ids[0],
          input.unattendedMode,
          token,
          actorId,
          actorId,
          now,
          now,
          ...eligible,
          ...eligible
        ),
      this.db
        .prepare(
          `DELETE FROM model_provider_account_pool_members
           WHERE provider = ? AND EXISTS (
             SELECT 1 FROM model_provider_account_defaults
             WHERE provider = ? AND write_token = ?
           )`
        )
        .bind(provider, provider, token),
      this.db
        .prepare(
          `INSERT INTO model_provider_account_pool_members (provider, provider_account_id, created_at)
           SELECT ?, id, ? FROM model_provider_accounts
           WHERE provider = ? AND id IN (${placeholders}) AND status = 'active' AND archived_at IS NULL
             AND EXISTS (
               SELECT 1 FROM model_provider_account_defaults
               WHERE provider = ? AND write_token = ?
             )`
        )
        .bind(provider, now, provider, ...ids, provider, token),
    ]);
    if (written.meta.changes !== 1 || inserted.meta.changes !== ids.length) {
      throw new ProviderDefaultConstraintError(
        `Random pool requires ${ids.length} active ${provider} accounts`
      );
    }
    return this.getRouting(provider);
  }
}

const providerRoutingRowSchema = z.object({
  provider: subscriptionProviderIdSchema,
  provider_account_id: z.string().min(1).nullable(),
  unattended_mode: providerAuthModeSchema,
  selection_mode: z.enum(["fixed", "random"]),
  created_by: auditUserIdSchema,
  updated_by: auditUserIdSchema,
  created_at: timestampMsSchema,
  updated_at: timestampMsSchema,
});

function unconfiguredRouting(provider: ModelProviderId): ProviderAccountRouting {
  return {
    provider,
    unattendedMode: "provider_account",
    selection: { mode: "unconfigured" },
  };
}
