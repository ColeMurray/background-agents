import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import type { ProviderAuthorizationRow } from "./provider-account-authorizations";
import type { ModelProviderAccountStatus } from "./model-provider-accounts";
import type { SqlDatabase, SqlStatement } from "./sql-database";

interface FinalizationInput {
  transaction: ProviderAuthorizationRow;
  owner: string;
  accountId: string;
  encryptedPayload: string;
  credentialSchemaVersion: number;
  credentialVersion: number;
  resultAccountLifecycleVersion: number;
  accessTokenExpiresAt: number | null;
  reconnectedExisting: boolean;
  now: number;
}

interface CreateFinalizationInput extends FinalizationInput {
  externalAccountId: string;
}

interface ReconnectFinalizationInput extends FinalizationInput {
  provider: ModelProviderId;
  externalAccountId: string;
  expectedAccountStatus: ModelProviderAccountStatus;
  expectedAccountLifecycleVersion: number;
  expectedCredentialVersion: number;
}

export class ProviderAccountAuthorizationFinalizationWriter {
  constructor(private readonly db: SqlDatabase) {}

  async create(input: CreateFinalizationInput): Promise<boolean> {
    const guard = this.authorizationGuard();
    const guardValues = this.authorizationGuardValues(input);
    // Each statement depends on the previous write winning, so the batch cannot skip a failed CAS.
    const results = await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO model_provider_accounts
            (id, provider, display_name, external_account_id, status, created_by, updated_by,
             last_verified_at, created_at, updated_at)
           SELECT ?, ?, ?, ?, 'active', ?, ?, ?, ?, ? WHERE EXISTS (${guard})`
        )
        .bind(
          input.accountId,
          input.transaction.provider,
          input.transaction.display_name,
          input.externalAccountId,
          input.transaction.user_id,
          input.transaction.user_id,
          input.now,
          input.now,
          input.now,
          ...guardValues
        ),
      this.db
        .prepare(
          `INSERT INTO model_provider_account_credentials
            (provider_account_id, encrypted_payload, credential_schema_version,
             access_token_expires_at, updated_at)
           SELECT ?, ?, ?, ?, ?
           WHERE changes() = 1 AND EXISTS (${guard})
             AND EXISTS (SELECT 1 FROM model_provider_accounts
                WHERE id = ? AND provider = ? AND external_account_id = ?
                  AND status = 'active' AND archived_at IS NULL
                  AND lifecycle_version = ?)`
        )
        .bind(
          input.accountId,
          input.encryptedPayload,
          input.credentialSchemaVersion,
          input.accessTokenExpiresAt,
          input.now,
          ...guardValues,
          input.accountId,
          input.transaction.provider,
          input.externalAccountId,
          input.resultAccountLifecycleVersion
        ),
      this.connectedStatement(input),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }

  async reconnect(input: ReconnectFinalizationInput): Promise<boolean> {
    const guard = this.authorizationGuard();
    const guardValues = this.authorizationGuardValues(input);
    // Each statement depends on the previous write winning, so the batch cannot skip a failed CAS.
    const results = await this.db.batch([
      this.db
        .prepare(
          `UPDATE model_provider_accounts
           SET status = 'active', updated_by = ?, last_verified_at = ?, updated_at = ?,
               lifecycle_version = lifecycle_version + 1
           WHERE id = ? AND provider = ? AND external_account_id = ?
             AND archived_at IS NULL AND status = ? AND lifecycle_version = ?
             AND EXISTS (${guard})
             AND EXISTS (SELECT 1 FROM model_provider_account_credentials
               WHERE provider_account_id = ? AND credential_version = ?)`
        )
        .bind(
          input.transaction.user_id,
          input.now,
          input.now,
          input.accountId,
          input.provider,
          input.externalAccountId,
          input.expectedAccountStatus,
          input.expectedAccountLifecycleVersion,
          ...guardValues,
          input.accountId,
          input.expectedCredentialVersion
        ),
      this.db
        .prepare(
          `UPDATE model_provider_account_credentials
           SET encrypted_payload = ?, credential_schema_version = ?, credential_version = ?,
               exchange_state = 'idle', exchange_owner = NULL, exchange_started_at = NULL,
               access_token_expires_at = ?, updated_at = ?
           WHERE changes() = 1
             AND provider_account_id = ? AND credential_version = ?
             AND EXISTS (${guard})
             AND EXISTS (SELECT 1 FROM model_provider_accounts
                WHERE id = ? AND provider = ? AND external_account_id = ?
                  AND status = 'active' AND archived_at IS NULL
                  AND lifecycle_version = ?)`
        )
        .bind(
          input.encryptedPayload,
          input.credentialSchemaVersion,
          input.credentialVersion,
          input.accessTokenExpiresAt,
          input.now,
          input.accountId,
          input.expectedCredentialVersion,
          ...guardValues,
          input.accountId,
          input.provider,
          input.externalAccountId,
          input.resultAccountLifecycleVersion
        ),
      this.connectedStatement(input),
    ]);
    return results.every((result) => result.meta.changes === 1);
  }

  private authorizationGuard(): string {
    return `SELECT 1 FROM model_provider_account_authorizations
      WHERE id = ? AND user_id = ? AND state = 'processing' AND processing_owner = ?
        AND expires_at > ?`;
  }

  private authorizationGuardValues(input: FinalizationInput): unknown[] {
    return [input.transaction.id, input.transaction.user_id, input.owner, input.now];
  }

  private connectedStatement(input: FinalizationInput): SqlStatement {
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
        input.transaction.id,
        input.transaction.user_id,
        input.owner,
        input.now,
        input.accountId,
        input.transaction.provider,
        input.resultAccountLifecycleVersion,
        input.accountId,
        input.credentialVersion,
        input.encryptedPayload
      );
  }
}
