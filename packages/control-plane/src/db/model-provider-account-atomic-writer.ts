import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import { encryptProviderAccountPayload } from "../auth/provider-account-crypto";
import type { ProcessingProviderAuthorization } from "./provider-account-authorizations";
import { ProviderAccountAuthorizationStore } from "./provider-account-authorizations";
import type { ModelProviderAccount, ModelProviderAccountStatus } from "./model-provider-accounts";
import { ModelProviderAccountStore } from "./model-provider-accounts";
import {
  ProviderCredentialStore,
  type ProviderCredentialExchangeAccountStatus,
} from "./provider-account-credentials";
import type { SqlDatabase, SqlStatement } from "./sql-database";
import { ProviderDefaultStore } from "./provider-account-defaults";

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

interface DeviceAuthorizationCredentialInput {
  authorization: ProcessingProviderAuthorization;
  externalAccountId: string;
  credential: unknown;
  credentialSchemaVersion: number;
  accessTokenExpiresAt: number | null;
  now: number;
}

export interface FinalizeDeviceAuthorizationCreateInput extends DeviceAuthorizationCredentialInput {
  authorization: ProcessingProviderAuthorization & { operation: "create" };
  accountId: string;
}

export interface FinalizeDeviceAuthorizationReconnectInput extends DeviceAuthorizationCredentialInput {
  accountId: string;
}

export type DeviceAuthorizationCreateOutcome =
  | { type: "created" }
  | { type: "identity_conflict" }
  | { type: "claim_lost" };

export type DeviceAuthorizationReconnectOutcome =
  | { type: "connected" }
  | { type: "claim_lost" }
  | { type: "target_changed" };

export interface ModelProviderAccountAtomicWriter {
  createAccountWithCredential(
    input: CreateAccountWithCredentialInput
  ): Promise<ModelProviderAccount>;
  reconnectCredentialAndAccount(input: AccountConnectionWriteInput): Promise<boolean>;
  completeVerificationCredentialAndAccount(
    input: CompleteVerificationCredentialAndAccountInput
  ): Promise<boolean>;
  finalizeDeviceAuthorizationCreate(
    input: FinalizeDeviceAuthorizationCreateInput
  ): Promise<DeviceAuthorizationCreateOutcome>;
  finalizeDeviceAuthorizationReconnect(
    input: FinalizeDeviceAuthorizationReconnectInput
  ): Promise<DeviceAuthorizationReconnectOutcome>;
  fenceExchangeAndRequireReconnect(input: FenceProviderCredentialExchangeInput): Promise<boolean>;
}

export class D1ModelProviderAccountAtomicWriter implements ModelProviderAccountAtomicWriter {
  private readonly accounts: ModelProviderAccountStore;
  private readonly credentials: ProviderCredentialStore;
  private readonly authorizations: ProviderAccountAuthorizationStore;
  private readonly defaults: ProviderDefaultStore;

  constructor(
    private readonly db: SqlDatabase,
    private readonly encryptionKey: string
  ) {
    this.accounts = new ModelProviderAccountStore(db);
    this.credentials = new ProviderCredentialStore(db, encryptionKey);
    this.authorizations = new ProviderAccountAuthorizationStore(db);
    this.defaults = new ProviderDefaultStore(db);
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
    await this.db.batch([
      accountStatement,
      credentialStatement,
      this.defaults.bindSetForFirstActiveAccount(
        input.id,
        input.provider,
        input.actorId,
        input.now
      ),
    ]);
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

  async finalizeDeviceAuthorizationCreate(
    input: FinalizeDeviceAuthorizationCreateInput
  ): Promise<DeviceAuthorizationCreateOutcome> {
    const encryptedPayload = await this.encryptDeviceCredential(input, input.accountId);
    const authorizationGuard = this.deviceAuthorizationGuard();
    const guardValues = this.deviceAuthorizationGuardValues(input.authorization, input.now);
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO model_provider_accounts
            (id, provider, display_name, external_account_id, status, created_by, updated_by,
             last_verified_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?
           WHERE EXISTS (${authorizationGuard})
             AND NOT EXISTS (SELECT 1 FROM model_provider_accounts
               WHERE provider = ? AND external_account_id = ? AND archived_at IS NULL)`
        )
        .bind(
          input.accountId,
          input.authorization.provider,
          input.authorization.displayName,
          input.externalAccountId,
          input.authorization.userId,
          input.authorization.userId,
          input.now,
          input.now,
          input.now,
          ...guardValues,
          input.authorization.provider,
          input.externalAccountId
        ),
      this.db
        .prepare(
          `INSERT INTO model_provider_account_credentials
            (provider_account_id, encrypted_payload, credential_schema_version,
             access_token_expires_at, updated_at)
           SELECT ?, ?, ?, ?, ? WHERE changes() = 1
             AND EXISTS (SELECT 1 FROM model_provider_accounts
               WHERE id = ? AND provider = ? AND external_account_id = ?
                 AND status = 'active' AND archived_at IS NULL AND lifecycle_version = 0)`
        )
        .bind(
          input.accountId,
          encryptedPayload,
          input.credentialSchemaVersion,
          input.accessTokenExpiresAt,
          input.now,
          input.accountId,
          input.authorization.provider,
          input.externalAccountId
        ),
      this.connectedAuthorizationStatement({
        ...input,
        encryptedPayload,
        credentialVersion: 1,
        accountLifecycleVersion: 0,
        reconnectedExisting: false,
      }),
      this.defaults.bindSetForFirstActiveAccount(
        input.accountId,
        input.authorization.provider,
        input.authorization.userId,
        input.now
      ),
    ]);
    const requiredResults = results.slice(0, 3);
    if (requiredResults.every((result) => result.meta.changes === 1)) return { type: "created" };
    if (requiredResults.some((result) => result.meta.changes !== 0)) {
      throw new Error("Provider authorization create finalization violated atomic invariants");
    }
    if (!(await this.ownsDeviceAuthorizationClaim(input.authorization, input.now))) {
      return { type: "claim_lost" };
    }
    const conflict = await this.accounts.findLifecycleSnapshotByExternalIdentity(
      input.authorization.provider,
      input.externalAccountId
    );
    if (conflict) return { type: "identity_conflict" };
    throw new Error("Provider authorization create finalization rejected without a conflict");
  }

  async finalizeDeviceAuthorizationReconnect(
    input: FinalizeDeviceAuthorizationReconnectInput
  ): Promise<DeviceAuthorizationReconnectOutcome> {
    if (!(await this.ownsDeviceAuthorizationClaim(input.authorization, input.now))) {
      return { type: "claim_lost" };
    }
    const snapshot = await this.accounts.getLifecycleSnapshot(input.accountId);
    if (
      !snapshot ||
      snapshot.account.archivedAt !== null ||
      snapshot.account.provider !== input.authorization.provider ||
      snapshot.account.externalAccountId !== input.externalAccountId ||
      (input.authorization.operation === "create" && snapshot.account.status === "disabled") ||
      (input.authorization.operation === "reconnect" &&
        (input.authorization.providerAccountId !== input.accountId ||
          input.authorization.targetAccountStatus !== snapshot.account.status ||
          input.authorization.targetAccountLifecycleVersion !== snapshot.lifecycleVersion))
    ) {
      return { type: "target_changed" };
    }
    const currentCredential = await this.credentials.readCredentialState(
      input.accountId,
      input.authorization.provider
    );
    if (!currentCredential) return { type: "target_changed" };

    const encryptedPayload = await this.encryptDeviceCredential(input, input.accountId);
    const nextCredentialVersion = currentCredential.credentialVersion + 1;
    const nextLifecycleVersion = snapshot.lifecycleVersion + 1;
    const authorizationGuard = this.deviceAuthorizationGuard();
    const guardValues = this.deviceAuthorizationGuardValues(input.authorization, input.now);
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE model_provider_accounts
           SET status = 'active', updated_by = ?, last_verified_at = ?, updated_at = ?,
               lifecycle_version = lifecycle_version + 1
           WHERE id = ? AND provider = ? AND external_account_id = ?
             AND archived_at IS NULL AND status = ? AND lifecycle_version = ?
             AND EXISTS (${authorizationGuard})
             AND EXISTS (SELECT 1 FROM model_provider_account_credentials
               WHERE provider_account_id = ? AND credential_version = ?)`
        )
        .bind(
          input.authorization.userId,
          input.now,
          input.now,
          input.accountId,
          input.authorization.provider,
          input.externalAccountId,
          snapshot.account.status,
          snapshot.lifecycleVersion,
          ...guardValues,
          input.accountId,
          currentCredential.credentialVersion
        ),
      this.db
        .prepare(
          `UPDATE model_provider_account_credentials
           SET encrypted_payload = ?, credential_schema_version = ?,
               credential_version = credential_version + 1,
               exchange_state = 'idle', exchange_owner = NULL, exchange_started_at = NULL,
               access_token_expires_at = ?, updated_at = ?
           WHERE changes() = 1 AND provider_account_id = ? AND credential_version = ?`
        )
        .bind(
          encryptedPayload,
          input.credentialSchemaVersion,
          input.accessTokenExpiresAt,
          input.now,
          input.accountId,
          currentCredential.credentialVersion
        ),
      this.connectedAuthorizationStatement({
        ...input,
        encryptedPayload,
        credentialVersion: nextCredentialVersion,
        accountLifecycleVersion: nextLifecycleVersion,
        reconnectedExisting: true,
      }),
    ]);
    if (results.every((result) => result.meta.changes === 1)) return { type: "connected" };
    if (results.some((result) => result.meta.changes !== 0)) {
      throw new Error("Provider authorization reconnect finalization violated atomic invariants");
    }
    return (await this.ownsDeviceAuthorizationClaim(input.authorization, input.now))
      ? { type: "target_changed" }
      : { type: "claim_lost" };
  }

  private encryptDeviceCredential(
    input: DeviceAuthorizationCredentialInput,
    providerAccountId: string
  ): Promise<string> {
    if (!Number.isInteger(input.credentialSchemaVersion) || input.credentialSchemaVersion <= 0) {
      throw new Error("Credential schema version must be a positive integer");
    }
    return encryptProviderAccountPayload(input.credential, this.encryptionKey, {
      providerAccountId,
      provider: input.authorization.provider,
      credentialSchemaVersion: input.credentialSchemaVersion,
    });
  }

  private deviceAuthorizationGuard(): string {
    return `SELECT 1 FROM model_provider_account_authorizations
      WHERE id = ? AND user_id = ? AND state = 'processing' AND processing_owner = ?
        AND expires_at > ?`;
  }

  private deviceAuthorizationGuardValues(
    authorization: ProcessingProviderAuthorization,
    now: number
  ): unknown[] {
    return [authorization.id, authorization.userId, authorization.processingOwner, now];
  }

  private async ownsDeviceAuthorizationClaim(
    authorization: ProcessingProviderAuthorization,
    now: number
  ): Promise<boolean> {
    const current = await this.authorizations.getOwned(authorization.userId, authorization.id);
    return (
      current?.state === "processing" &&
      current.processingOwner === authorization.processingOwner &&
      current.expiresAt > now
    );
  }

  private connectedAuthorizationStatement(
    input: DeviceAuthorizationCredentialInput & {
      accountId: string;
      encryptedPayload: string;
      credentialVersion: number;
      accountLifecycleVersion: number;
      reconnectedExisting: boolean;
    }
  ): SqlStatement {
    return this.db
      .prepare(
        `UPDATE model_provider_account_authorizations
         SET state = 'connected', encrypted_provider_data = NULL, provider_state_version = NULL,
             processing_owner = NULL, processing_started_at = NULL,
             result_provider_account_id = ?, reconnected_existing = ?,
             completed_at = ?, updated_at = ?
         WHERE changes() = 1
           AND id = ? AND user_id = ? AND state = 'processing' AND processing_owner = ?
           AND expires_at > ?
           AND EXISTS (SELECT 1 FROM model_provider_accounts
             WHERE id = ? AND provider = ? AND status = 'active' AND archived_at IS NULL
               AND lifecycle_version = ?)
           AND EXISTS (SELECT 1 FROM model_provider_account_credentials
             WHERE provider_account_id = ? AND credential_version = ? AND encrypted_payload = ?)`
      )
      .bind(
        input.accountId,
        input.reconnectedExisting ? 1 : 0,
        input.now,
        input.now,
        input.authorization.id,
        input.authorization.userId,
        input.authorization.processingOwner,
        input.now,
        input.accountId,
        input.authorization.provider,
        input.accountLifecycleVersion,
        input.accountId,
        input.credentialVersion,
        input.encryptedPayload
      );
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
