import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import type { ModelProviderAccount, ModelProviderAccountStatus } from "./model-provider-accounts";
import { ModelProviderAccountStore } from "./model-provider-accounts";
import {
  ProviderCredentialStore,
  type ProviderCredentialExchangeAccountStatus,
} from "./provider-account-credentials";
import type { SqlDatabase } from "./sql-database";

interface CredentialWriteInput {
  providerAccountId: string;
  provider: ModelProviderId;
  credentialSchemaVersion: number;
  payload: unknown;
  accessTokenExpiresAt?: number | null;
  now: number;
}

export interface AccountConnectionWriteInput extends CredentialWriteInput {
  expectedCredentialVersion: number;
  externalAccountId: string | null;
  status: ModelProviderAccountStatus;
  actorId: string;
  lastVerifiedAt: number;
}

export interface CompleteVerificationCredentialAndAccountInput extends AccountConnectionWriteInput {
  expectedAccountStatus: ProviderCredentialExchangeAccountStatus;
  exchangeGeneration: number;
  exchangeOwner: string;
}

export interface FenceProviderCredentialExchangeInput {
  providerAccountId: string;
  credentialVersion: number;
  exchangeGeneration: number;
  exchangeOwner: string;
  now: number;
}

export interface CreateAccountWithCredentialInput {
  id: string;
  provider: ModelProviderId;
  displayName: string;
  externalAccountId: string | null;
  actorId: string;
  now: number;
  credential: Pick<
    CredentialWriteInput,
    "credentialSchemaVersion" | "payload" | "accessTokenExpiresAt"
  >;
}

export interface ModelProviderAccountAtomicWriter {
  createAccountWithCredential(
    input: CreateAccountWithCredentialInput
  ): Promise<ModelProviderAccount>;
  reconnectCredentialAndAccount(input: AccountConnectionWriteInput): Promise<boolean>;
  completeVerificationCredentialAndAccount(
    input: CompleteVerificationCredentialAndAccountInput
  ): Promise<boolean>;
  fenceExchangeAndRequireReconnect(input: FenceProviderCredentialExchangeInput): Promise<boolean>;
}

export class D1ModelProviderAccountAtomicWriter implements ModelProviderAccountAtomicWriter {
  private readonly accounts: ModelProviderAccountStore;
  private readonly credentials: ProviderCredentialStore;

  constructor(
    private readonly db: SqlDatabase,
    encryptionKey: string
  ) {
    this.accounts = new ModelProviderAccountStore(db);
    this.credentials = new ProviderCredentialStore(db, encryptionKey);
  }

  async createAccountWithCredential(
    input: CreateAccountWithCredentialInput
  ): Promise<ModelProviderAccount> {
    const accountStatement = this.accounts.bindCreate({ ...input, lastVerifiedAt: input.now });
    const credentialStatement = await this.credentials.bindCreateForAccountBatch({
      providerAccountId: input.id,
      provider: input.provider,
      ...input.credential,
      now: input.now,
    });
    await this.db.batch([accountStatement, credentialStatement]);
    const account = await this.accounts.getById(input.id);
    if (!account) throw new Error("Created provider account could not be read");
    return account;
  }

  async reconnectCredentialAndAccount(input: AccountConnectionWriteInput): Promise<boolean> {
    const prepared = await this.credentials.prepareReplace(input);
    const results = await this.db.batch([
      prepared.statement,
      this.accounts.bindUpdateConnection(input.providerAccountId, {
        ...input,
        credentialVersion: input.expectedCredentialVersion + 1,
        encryptedPayload: prepared.encryptedPayload,
      }),
    ]);
    return results[0].meta.changes === 1 && results[1].meta.changes === 1;
  }

  async completeVerificationCredentialAndAccount(
    input: CompleteVerificationCredentialAndAccountInput
  ): Promise<boolean> {
    const prepared = await this.credentials.prepareCompleteExchange(input);
    const results = await this.db.batch([
      prepared.statement,
      this.accounts.bindUpdateConnection(input.providerAccountId, {
        ...input,
        credentialVersion: input.expectedCredentialVersion + 1,
        encryptedPayload: prepared.encryptedPayload,
      }),
    ]);
    return results[0].meta.changes === 1 && results[1].meta.changes === 1;
  }

  async fenceExchangeAndRequireReconnect(
    input: FenceProviderCredentialExchangeInput
  ): Promise<boolean> {
    const leaseGuard = `SELECT 1 FROM model_provider_account_credentials
      WHERE provider_account_id = model_provider_accounts.id
        AND credential_version = ? AND exchange_generation = ?
        AND exchange_owner = ? AND exchange_state = 'in_flight'`;
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE model_provider_accounts
            SET status = 'reconnect_required', updated_by = NULL, updated_at = ?
            WHERE id = ? AND archived_at IS NULL AND status = 'active'
              AND EXISTS (${leaseGuard})`
        )
        .bind(
          input.now,
          input.providerAccountId,
          input.credentialVersion,
          input.exchangeGeneration,
          input.exchangeOwner
        ),
      this.db
        .prepare(
          `UPDATE model_provider_account_credentials
           SET exchange_state = 'idle', exchange_owner = NULL, exchange_started_at = NULL,
               exchange_generation = exchange_generation + 1, updated_at = ?
           WHERE provider_account_id = ? AND credential_version = ?
             AND exchange_generation = ? AND exchange_owner = ? AND exchange_state = 'in_flight'
             AND EXISTS (
               SELECT 1 FROM model_provider_accounts
               WHERE model_provider_accounts.id = model_provider_account_credentials.provider_account_id
                 AND model_provider_accounts.status = 'reconnect_required'
                 AND model_provider_accounts.archived_at IS NULL
             )`
        )
        .bind(
          input.now,
          input.providerAccountId,
          input.credentialVersion,
          input.exchangeGeneration,
          input.exchangeOwner
        ),
    ]);
    return results[0].meta.changes === 1 && results[1].meta.changes === 1;
  }
}
