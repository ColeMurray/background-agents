import {
  decryptProviderAccountPayload,
  encryptProviderAccountPayload,
} from "../auth/provider-account-crypto";
import {
  assertModelProviderId,
  type ModelProviderId,
} from "../model-provider-accounts/provider-auth-contracts";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import type { ModelProviderAccountStatus } from "@open-inspect/shared/types/provider-accounts";

type ProviderCredentialExchangeState = "idle" | "in_flight";
export type ProviderCredentialExchangeAccountStatus = Exclude<
  ModelProviderAccountStatus,
  "disabled"
>;

interface CredentialRow {
  encrypted_payload: string;
  credential_schema_version: number;
  credential_version: number;
  exchange_generation: number;
  exchange_state: ProviderCredentialExchangeState;
  exchange_owner: string | null;
  exchange_started_at: number | null;
  access_token_expires_at: number | null;
  updated_at: number;
}

export interface ProviderCredentialState<T = unknown> {
  payload: T;
  credentialSchemaVersion: number;
  credentialVersion: number;
  exchangeGeneration: number;
  exchangeState: ProviderCredentialExchangeState;
  exchangeOwner: string | null;
  exchangeStartedAt: number | null;
  accessTokenExpiresAt: number | null;
  updatedAt: number;
}

interface CredentialPayloadInput {
  providerAccountId: string;
  provider: ModelProviderId;
  credentialSchemaVersion: number;
  payload: unknown;
  accessTokenExpiresAt?: number | null;
  now?: number;
}

export interface CompleteProviderExchangeInput extends CredentialPayloadInput {
  expectedCredentialVersion: number;
  expectedAccountStatus: ProviderCredentialExchangeAccountStatus;
  exchangeGeneration: number;
  exchangeOwner: string;
}

export interface PreparedCredentialWrite {
  statement: SqlStatement;
  encryptedPayload: string;
}

export class ProviderCredentialStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {}

  async create(input: CredentialPayloadInput): Promise<void> {
    assertModelProviderId(input.provider);
    const encrypted = await this.encrypt(input);
    const result = await this.db
      .prepare(
        `INSERT INTO model_provider_account_credentials (
           provider_account_id, encrypted_payload, credential_schema_version,
           access_token_expires_at, updated_at
         )
         SELECT id, ?, ?, ?, ? FROM model_provider_accounts
         WHERE id = ? AND provider = ?`
      )
      .bind(
        encrypted,
        input.credentialSchemaVersion,
        input.accessTokenExpiresAt ?? null,
        input.now ?? Date.now(),
        input.providerAccountId,
        input.provider
      )
      .run();
    if (result.meta.changes === 0) {
      throw new Error(
        `Provider account ${input.providerAccountId} does not belong to ${input.provider}`
      );
    }
  }

  async bindCreateForAccountBatch(input: CredentialPayloadInput): Promise<SqlStatement> {
    assertModelProviderId(input.provider);
    const encrypted = await this.encrypt(input);
    return this.db
      .prepare(
        `INSERT INTO model_provider_account_credentials (
           provider_account_id, encrypted_payload, credential_schema_version,
           access_token_expires_at, updated_at
         ) VALUES (?, ?, ?, ?, ?)`
      )
      .bind(
        input.providerAccountId,
        encrypted,
        input.credentialSchemaVersion,
        input.accessTokenExpiresAt ?? null,
        input.now ?? Date.now()
      );
  }

  async readCredentialState<T = unknown>(
    providerAccountId: string,
    provider: ModelProviderId
  ): Promise<ProviderCredentialState<T> | null> {
    assertModelProviderId(provider);
    const row = await this.db
      .prepare(
        `SELECT credentials.* FROM model_provider_account_credentials credentials
         JOIN model_provider_accounts accounts ON accounts.id = credentials.provider_account_id
         WHERE credentials.provider_account_id = ? AND accounts.provider = ?`
      )
      .bind(providerAccountId, provider)
      .first<CredentialRow>();
    if (!row) return null;
    return {
      payload: await decryptProviderAccountPayload<T>(row.encrypted_payload, this.encryptionKey, {
        providerAccountId,
        provider,
        credentialSchemaVersion: row.credential_schema_version,
      }),
      credentialSchemaVersion: row.credential_schema_version,
      credentialVersion: row.credential_version,
      exchangeGeneration: row.exchange_generation,
      exchangeState: row.exchange_state,
      exchangeOwner: row.exchange_owner,
      exchangeStartedAt: row.exchange_started_at,
      accessTokenExpiresAt: row.access_token_expires_at,
      updatedAt: row.updated_at,
    };
  }

  async replace(
    input: CredentialPayloadInput & { expectedCredentialVersion: number }
  ): Promise<boolean> {
    const prepared = await this.prepareReplace(input);
    const result = await prepared.statement.run();
    return result.meta.changes > 0;
  }

  async prepareReplace(
    input: CredentialPayloadInput & { expectedCredentialVersion: number }
  ): Promise<PreparedCredentialWrite> {
    assertModelProviderId(input.provider);
    const encrypted = await this.encrypt(input);
    const statement = this.db
      .prepare(
        `UPDATE model_provider_account_credentials
         SET encrypted_payload = ?, credential_schema_version = ?,
             credential_version = credential_version + 1,
             exchange_state = 'idle', exchange_owner = NULL, exchange_started_at = NULL,
             access_token_expires_at = ?, updated_at = ?
         WHERE provider_account_id = ? AND credential_version = ?
           AND EXISTS (
             SELECT 1 FROM model_provider_accounts
              WHERE id = provider_account_id AND provider = ? AND archived_at IS NULL
           )`
      )
      .bind(
        encrypted,
        input.credentialSchemaVersion,
        input.accessTokenExpiresAt ?? null,
        input.now ?? Date.now(),
        input.providerAccountId,
        input.expectedCredentialVersion,
        input.provider
      );
    return { statement, encryptedPayload: encrypted };
  }

  async tryBeginExchange(
    providerAccountId: string,
    expectedCredentialVersion: number,
    exchangeOwner: string,
    expectedAccountStatus: ProviderCredentialExchangeAccountStatus,
    now = Date.now()
  ): Promise<{ acquired: true; generation: number } | { acquired: false }> {
    const row = await this.db
      .prepare(
        `UPDATE model_provider_account_credentials
         SET exchange_state = 'in_flight', exchange_owner = ?,
             exchange_generation = exchange_generation + 1,
             exchange_started_at = ?, updated_at = ?
         WHERE provider_account_id = ? AND credential_version = ? AND exchange_state = 'idle'
           AND EXISTS (
             SELECT 1 FROM model_provider_accounts
             WHERE id = provider_account_id AND status = ? AND archived_at IS NULL
           )
         RETURNING exchange_generation`
      )
      .bind(
        exchangeOwner,
        now,
        now,
        providerAccountId,
        expectedCredentialVersion,
        expectedAccountStatus
      )
      .first<{ exchange_generation: number }>();
    return row ? { acquired: true, generation: row.exchange_generation } : { acquired: false };
  }

  async completeExchange(input: CompleteProviderExchangeInput): Promise<boolean> {
    const prepared = await this.prepareCompleteExchange(input);
    const result = await prepared.statement.run();
    return result.meta.changes > 0;
  }

  async prepareCompleteExchange(
    input: CompleteProviderExchangeInput
  ): Promise<PreparedCredentialWrite> {
    assertModelProviderId(input.provider);
    const encrypted = await this.encrypt(input);
    const statement = this.db
      .prepare(
        `UPDATE model_provider_account_credentials
         SET encrypted_payload = ?, credential_schema_version = ?,
             credential_version = credential_version + 1,
             exchange_state = 'idle', exchange_owner = NULL, exchange_started_at = NULL,
             access_token_expires_at = ?, updated_at = ?
         WHERE provider_account_id = ? AND credential_version = ?
           AND exchange_generation = ? AND exchange_owner = ? AND exchange_state = 'in_flight'
           AND EXISTS (
             SELECT 1 FROM model_provider_accounts
              WHERE id = provider_account_id AND provider = ? AND status = ?
                AND archived_at IS NULL
           )`
      )
      .bind(
        encrypted,
        input.credentialSchemaVersion,
        input.accessTokenExpiresAt ?? null,
        input.now ?? Date.now(),
        input.providerAccountId,
        input.expectedCredentialVersion,
        input.exchangeGeneration,
        input.exchangeOwner,
        input.provider,
        input.expectedAccountStatus
      );
    return { statement, encryptedPayload: encrypted };
  }

  async clearSafeFailure(
    providerAccountId: string,
    expectedCredentialVersion: number,
    exchangeGeneration: number,
    exchangeOwner: string,
    now = Date.now()
  ): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE model_provider_account_credentials
         SET exchange_state = 'idle', exchange_owner = NULL, exchange_started_at = NULL, updated_at = ?
         WHERE provider_account_id = ? AND credential_version = ?
           AND exchange_generation = ? AND exchange_owner = ? AND exchange_state = 'in_flight'`
      )
      .bind(now, providerAccountId, expectedCredentialVersion, exchangeGeneration, exchangeOwner)
      .run();
    return result.meta.changes > 0;
  }

  private encrypt(input: CredentialPayloadInput): Promise<string> {
    if (!Number.isInteger(input.credentialSchemaVersion) || input.credentialSchemaVersion <= 0) {
      throw new Error("Credential schema version must be a positive integer");
    }
    return encryptProviderAccountPayload(input.payload, this.encryptionKey, {
      providerAccountId: input.providerAccountId,
      provider: input.provider,
      credentialSchemaVersion: input.credentialSchemaVersion,
    });
  }
}
