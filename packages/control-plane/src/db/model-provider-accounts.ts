import {
  modelProviderAccountStatusSchema,
  type ModelProviderAccount as SharedModelProviderAccount,
  type ModelProviderAccountStatus,
} from "@open-inspect/shared/types/provider-accounts";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import {
  assertModelProviderId,
  type ModelProviderId,
} from "../model-provider-accounts/provider-auth-contracts";

export type { ModelProviderAccountStatus };
export type ModelProviderAccount = SharedModelProviderAccount;

interface AccountRow {
  id: string;
  provider: string;
  display_name: string;
  external_account_id: string | null;
  status: string;
  created_by: string | null;
  updated_by: string | null;
  last_verified_at: number | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  lifecycle_version: number;
}

export interface CreateModelProviderAccount {
  id: string;
  provider: ModelProviderId;
  displayName: string;
  externalAccountId?: string | null;
  status?: ModelProviderAccountStatus;
  actorId?: string | null;
  lastVerifiedAt?: number | null;
  now?: number;
}

export interface ModelProviderAccountLifecycleSnapshot {
  account: ModelProviderAccount;
  lifecycleVersion: number;
}

function toAccount(row: AccountRow): ModelProviderAccount {
  assertModelProviderId(row.provider);
  return {
    id: row.id,
    provider: row.provider,
    displayName: row.display_name,
    externalAccountId: row.external_account_id,
    status: modelProviderAccountStatusSchema.parse(row.status),
    createdBy: row.created_by,
    updatedBy: row.updated_by,
    lastVerifiedAt: row.last_verified_at,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

function toLifecycleSnapshot(row: AccountRow): ModelProviderAccountLifecycleSnapshot {
  return { account: toAccount(row), lifecycleVersion: row.lifecycle_version };
}

export class ModelProviderAccountStore {
  constructor(private readonly db: SqlDatabase) {}

  async create(input: CreateModelProviderAccount): Promise<void> {
    await this.bindCreate(input).run();
  }

  bindCreate(input: CreateModelProviderAccount): SqlStatement {
    assertModelProviderId(input.provider);
    const now = input.now ?? Date.now();
    return this.db
      .prepare(
        `INSERT INTO model_provider_accounts (
           id, provider, display_name, external_account_id,
           status, created_by, updated_by, last_verified_at,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        input.id,
        input.provider,
        input.displayName,
        input.externalAccountId ?? null,
        input.status ?? "active",
        input.actorId ?? null,
        input.actorId ?? null,
        input.lastVerifiedAt ?? null,
        now,
        now
      );
  }

  async getById(id: string): Promise<ModelProviderAccount | null> {
    const row = await this.db
      .prepare("SELECT * FROM model_provider_accounts WHERE id = ?")
      .bind(id)
      .first<AccountRow>();
    return row ? toAccount(row) : null;
  }

  async getLifecycleSnapshot(id: string): Promise<ModelProviderAccountLifecycleSnapshot | null> {
    const row = await this.db
      .prepare("SELECT * FROM model_provider_accounts WHERE id = ?")
      .bind(id)
      .first<AccountRow>();
    return row ? toLifecycleSnapshot(row) : null;
  }

  async findByExternalIdentity(
    provider: ModelProviderId,
    externalAccountId: string
  ): Promise<ModelProviderAccount | null> {
    assertModelProviderId(provider);
    const row = await this.db
      .prepare(
        `SELECT * FROM model_provider_accounts
         WHERE provider = ? AND external_account_id = ?
            AND archived_at IS NULL`
      )
      .bind(provider, externalAccountId)
      .first<AccountRow>();
    return row ? toAccount(row) : null;
  }

  async findLifecycleSnapshotByExternalIdentity(
    provider: ModelProviderId,
    externalAccountId: string
  ): Promise<ModelProviderAccountLifecycleSnapshot | null> {
    assertModelProviderId(provider);
    const row = await this.db
      .prepare(
        `SELECT * FROM model_provider_accounts
         WHERE provider = ? AND external_account_id = ?
           AND archived_at IS NULL`
      )
      .bind(provider, externalAccountId)
      .first<AccountRow>();
    return row ? toLifecycleSnapshot(row) : null;
  }

  bindUpdateConnection(
    id: string,
    input: {
      externalAccountId: string | null;
      status: ModelProviderAccountStatus;
      actorId: string;
      lastVerifiedAt: number;
      now: number;
      credentialVersion: number;
      encryptedPayload: string;
      exchangeGeneration?: number;
    }
  ): SqlStatement {
    return this.db
      .prepare(
        `UPDATE model_provider_accounts
         SET external_account_id = ?, status = ?, updated_by = ?, last_verified_at = ?,
             updated_at = ?, lifecycle_version = lifecycle_version + 1
         WHERE id = ? AND archived_at IS NULL AND EXISTS (
           SELECT 1 FROM model_provider_account_credentials
           WHERE provider_account_id = model_provider_accounts.id
             AND credential_version = ? AND encrypted_payload = ?
             AND (? IS NULL OR exchange_generation = ?)
         )`
      )
      .bind(
        input.externalAccountId,
        input.status,
        input.actorId,
        input.lastVerifiedAt,
        input.now,
        id,
        input.credentialVersion,
        input.encryptedPayload,
        input.exchangeGeneration ?? null,
        input.exchangeGeneration ?? null
      );
  }

  async list(provider?: ModelProviderId, includeArchived = false): Promise<ModelProviderAccount[]> {
    if (provider) assertModelProviderId(provider);
    const clauses = [
      provider ? "provider = ?" : null,
      includeArchived ? null : "archived_at IS NULL",
    ]
      .filter(Boolean)
      .join(" AND ");
    const statement = this.db.prepare(
      `SELECT * FROM model_provider_accounts${clauses ? ` WHERE ${clauses}` : ""}
       ORDER BY provider, display_name, id`
    );
    const result = await (provider ? statement.bind(provider) : statement).all<AccountRow>();
    return result.results.map(toAccount);
  }

  async updateDetails(
    id: string,
    input: {
      displayName: string;
      actorId?: string | null;
      now?: number;
    }
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_accounts
         SET display_name = ?, updated_by = ?, updated_at = ?
         WHERE id = ? AND archived_at IS NULL`
      )
      .bind(input.displayName, input.actorId ?? null, input.now ?? Date.now(), id)
      .run();
    return result.meta.changes > 0;
  }

  async setStatus(
    id: string,
    status: ModelProviderAccountStatus,
    actorId: string | null,
    now = Date.now()
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_accounts
         SET status = ?, updated_by = ?, updated_at = ?,
             lifecycle_version = lifecycle_version + 1
         WHERE id = ? AND archived_at IS NULL`
      )
      .bind(status, actorId, now, id)
      .run();
    return result.meta.changes > 0;
  }

  async archive(id: string, actorId: string | null, now = Date.now()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_accounts
         SET archived_at = ?, updated_by = ?, updated_at = ?,
             lifecycle_version = lifecycle_version + 1
         WHERE id = ? AND archived_at IS NULL`
      )
      .bind(now, actorId, now, id)
      .run();
    return result.meta.changes > 0;
  }

  async touchLastUsed(id: string, before: number, now = Date.now()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_accounts SET last_used_at = ?, updated_at = ?
         WHERE id = ? AND (last_used_at IS NULL OR last_used_at < ?)`
      )
      .bind(now, now, id, before)
      .run();
    return result.meta.changes > 0;
  }
}
