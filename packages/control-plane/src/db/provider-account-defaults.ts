import {
  providerAuthModeSchema,
  subscriptionProviderIdSchema,
  type ModelProviderAccountDefault,
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

  async set(
    provider: ModelProviderId,
    providerAccountId: string,
    unattendedMode: ProviderUnattendedMode,
    actorId: string | null,
    now = Date.now()
  ): Promise<void> {
    assertModelProviderId(provider);
    assertValidDefaultWrite(actorId, now);
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
           updated_at = excluded.updated_at`
      )
      .bind(provider, unattendedMode, actorId, actorId, now, now, providerAccountId, provider)
      .run();
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
          (provider, provider_account_id, unattended_mode, created_by, updated_by,
           created_at, updated_at)
         SELECT ?, id, 'provider_account', ?, ?, ?, ?
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
      .prepare("SELECT * FROM model_provider_account_defaults WHERE provider = ?")
      .bind(provider)
      .first<unknown>();
    return row ? toDefault(parseDefaultRow(row)) : null;
  }

  async list(): Promise<ProviderDefault[]> {
    const rows = await this.db
      .prepare("SELECT * FROM model_provider_account_defaults ORDER BY provider")
      .all<unknown>();
    return rows.results.map((row) => toDefault(parseDefaultRow(row)));
  }

  async remove(provider: ModelProviderId): Promise<boolean> {
    assertModelProviderId(provider);
    const result = await this.db
      .prepare("DELETE FROM model_provider_account_defaults WHERE provider = ?")
      .bind(provider)
      .run();
    return result.meta.changes > 0;
  }
}
