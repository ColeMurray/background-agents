import { encryptProviderAccountPayload } from "../auth/provider-account-crypto";
import type {
  ModelProviderAccountAdapter,
  ProviderConnectionResult,
} from "../auth/model-provider-account-adapters";
import type { ProviderAuthorizationRow } from "../db/provider-account-authorizations";
import type {
  ModelProviderAccountStore,
  ModelProviderAccountLifecycleSnapshot,
} from "../db/model-provider-accounts";
import type { ProviderCredentialStore } from "../db/provider-account-credentials";
import type { ProviderAccountAuthorizationFinalizationWriter } from "../db/provider-account-authorization-finalization";

export type ProviderDeviceAuthorizationFinalizerAccountStore = Pick<
  ModelProviderAccountStore,
  "getLifecycleSnapshot" | "findLifecycleSnapshotByExternalIdentity"
>;
export type ProviderDeviceAuthorizationFinalizerCredentialStore = Pick<
  ProviderCredentialStore,
  "readCredentialState"
>;

export class ProviderDeviceAuthorizationFinalizer {
  constructor(
    private readonly accounts: ProviderDeviceAuthorizationFinalizerAccountStore,
    private readonly credentials: ProviderDeviceAuthorizationFinalizerCredentialStore,
    private readonly writer: ProviderAccountAuthorizationFinalizationWriter,
    private readonly encryptionKey: string,
    private readonly generateAccountId: () => string
  ) {}

  async finalizeTrustedConnection(
    transaction: ProviderAuthorizationRow,
    processingOwner: string,
    connection: ProviderConnectionResult<unknown>,
    adapter: ModelProviderAccountAdapter<unknown, unknown>,
    now: number
  ): Promise<boolean> {
    const identity = connection.externalAccountId;
    if (!identity) throw new Error("Provider account identity could not be verified");

    if (transaction.operation === "reconnect") {
      const snapshot = await this.accounts.getLifecycleSnapshot(transaction.provider_account_id!);
      const account = snapshot?.account;
      if (!account || account.archivedAt !== null || account.provider !== transaction.provider) {
        throw new Error("Provider account is unavailable for reconnection");
      }
      if (!account.externalAccountId || account.externalAccountId !== identity) {
        throw new Error("Provider account identity did not match");
      }
      return this.reconnect(transaction, processingOwner, snapshot, connection, adapter, now);
    }

    const existing = await this.accounts.findLifecycleSnapshotByExternalIdentity(
      transaction.provider,
      identity
    );
    if (existing) {
      if (existing.account.status === "disabled") {
        throw new Error("Provider account is unavailable for reconnection");
      }
      return this.reconnect(transaction, processingOwner, existing, connection, adapter, now);
    }

    try {
      return await this.create(transaction, processingOwner, connection, adapter, identity, now);
    } catch (cause) {
      // A concurrent create may win the unique provider identity; converge on that account.
      const winner = await this.accounts.findLifecycleSnapshotByExternalIdentity(
        transaction.provider,
        identity
      );
      if (!winner) throw cause;
      if (winner.account.status === "disabled") {
        throw new Error("Provider account is unavailable for reconnection");
      }
      return this.reconnect(transaction, processingOwner, winner, connection, adapter, now);
    }
  }

  private async create(
    transaction: ProviderAuthorizationRow,
    owner: string,
    connection: ProviderConnectionResult<unknown>,
    adapter: ModelProviderAccountAdapter<unknown, unknown>,
    identity: string,
    now: number
  ): Promise<boolean> {
    const accountId = this.generateAccountId();
    const encrypted = await encryptProviderAccountPayload(
      connection.credential,
      this.encryptionKey,
      {
        providerAccountId: accountId,
        provider: transaction.provider,
        credentialSchemaVersion: adapter.credentialSchemaVersion,
      }
    );
    return this.writer.create({
      transaction,
      owner,
      accountId,
      externalAccountId: identity,
      encryptedPayload: encrypted,
      credentialSchemaVersion: adapter.credentialSchemaVersion,
      credentialVersion: 1,
      resultAccountLifecycleVersion: 0,
      accessTokenExpiresAt: connection.accessTokenExpiresAt ?? null,
      reconnectedExisting: false,
      now,
    });
  }

  private async reconnect(
    transaction: ProviderAuthorizationRow,
    owner: string,
    snapshot: ModelProviderAccountLifecycleSnapshot,
    connection: ProviderConnectionResult<unknown>,
    adapter: ModelProviderAccountAdapter<unknown, unknown>,
    now: number
  ): Promise<boolean> {
    const { account } = snapshot;
    const current = await this.credentials.readCredentialState(account.id, account.provider);
    if (!current) throw new Error("Provider credential is unavailable for reconnection");
    const encrypted = await encryptProviderAccountPayload(
      connection.credential,
      this.encryptionKey,
      {
        providerAccountId: account.id,
        provider: account.provider,
        credentialSchemaVersion: adapter.credentialSchemaVersion,
      }
    );
    const nextVersion = current.credentialVersion + 1;
    const expectedAccountLifecycleVersion =
      transaction.operation === "reconnect"
        ? transaction.target_account_lifecycle_version!
        : snapshot.lifecycleVersion;
    return this.writer.reconnect({
      transaction,
      owner,
      accountId: account.id,
      provider: account.provider,
      externalAccountId: account.externalAccountId!,
      expectedAccountStatus:
        transaction.operation === "reconnect" ? transaction.target_account_status! : account.status,
      expectedAccountLifecycleVersion,
      expectedCredentialVersion: current.credentialVersion,
      encryptedPayload: encrypted,
      credentialSchemaVersion: adapter.credentialSchemaVersion,
      credentialVersion: nextVersion,
      resultAccountLifecycleVersion: expectedAccountLifecycleVersion + 1,
      accessTokenExpiresAt: connection.accessTokenExpiresAt ?? null,
      reconnectedExisting: true,
      now,
    });
  }
}
