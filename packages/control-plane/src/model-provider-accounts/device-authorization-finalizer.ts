import type {
  ModelProviderAccountAdapter,
  ProviderConnectionResult,
} from "../auth/model-provider-account-adapters";
import type { ProcessingProviderAuthorization } from "../db/provider-account-authorizations";
import type {
  ModelProviderAccountStore,
  ModelProviderAccountLifecycleSnapshot,
} from "../db/model-provider-accounts";
import type { ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";

export type ProviderDeviceAuthorizationFinalizerAccountStore = Pick<
  ModelProviderAccountStore,
  "getLifecycleSnapshot" | "findLifecycleSnapshotByExternalIdentity"
>;

export class ProviderDeviceAuthorizationFinalizer {
  constructor(
    private readonly accounts: ProviderDeviceAuthorizationFinalizerAccountStore,
    private readonly writer: Pick<
      ModelProviderAccountAtomicWriter,
      "finalizeDeviceAuthorizationCreate" | "finalizeDeviceAuthorizationReconnect"
    >,
    private readonly generateAccountId: () => string
  ) {}

  /**
   * Persist a connection the provider itself vouched for. Identity-bound
   * providers converge on the external account id: a create that lands on a
   * known identity reconnects it, and a reconnect must present the target's
   * identity. Identity-less connections (the adapter accepts a missing id)
   * name a fresh slot on create and write straight to the target on reconnect.
   */
  async finalizeTrustedConnection(
    transaction: ProcessingProviderAuthorization,
    connection: ProviderConnectionResult<unknown>,
    adapter: ModelProviderAccountAdapter<unknown, unknown>,
    now: number
  ): Promise<boolean> {
    const identity = connection.externalAccountId;

    if (transaction.operation === "reconnect") {
      const snapshot = await this.accounts.getLifecycleSnapshot(transaction.providerAccountId);
      const account = snapshot?.account;
      if (!account || account.archivedAt !== null || account.provider !== transaction.provider) {
        throw new Error("Provider account is unavailable for reconnection");
      }
      if (identity === undefined) {
        adapter.validateExternalIdentity(identity, account.externalAccountId);
        if (account.externalAccountId !== null) {
          throw new Error("Provider account identity could not be verified");
        }
      } else if (!account.externalAccountId || account.externalAccountId !== identity) {
        throw new Error("Provider account identity did not match");
      }
      return this.reconnect(transaction, snapshot, connection, adapter, now);
    }

    if (identity === undefined) {
      adapter.validateExternalIdentity(identity, null);
      const outcome = await this.create(transaction, connection, adapter, null, now);
      if (outcome === "identity_conflict") {
        throw new Error("Identity-less provider account reported an identity conflict");
      }
      return outcome === "created";
    }

    const existing = await this.accounts.findLifecycleSnapshotByExternalIdentity(
      transaction.provider,
      identity
    );
    if (existing) {
      if (existing.account.status === "disabled") {
        throw new Error("Provider account is unavailable for reconnection");
      }
      return this.reconnect(transaction, existing, connection, adapter, now);
    }

    const outcome = await this.create(transaction, connection, adapter, identity, now);
    if (outcome !== "identity_conflict") return outcome === "created";

    // A concurrent create won the unique provider identity. Converge only on
    // that explicit writer outcome; encryption and database failures propagate.
    const winner = await this.accounts.findLifecycleSnapshotByExternalIdentity(
      transaction.provider,
      identity
    );
    if (!winner) throw new Error("Provider identity conflict winner could not be read");
    if (winner.account.status === "disabled") {
      throw new Error("Provider account is unavailable for reconnection");
    }
    return this.reconnect(transaction, winner, connection, adapter, now);
  }

  private async create(
    transaction: ProcessingProviderAuthorization & { operation: "create" },
    connection: ProviderConnectionResult<unknown>,
    adapter: ModelProviderAccountAdapter<unknown, unknown>,
    identity: string | null,
    now: number
  ): Promise<"created" | "identity_conflict" | "claim_lost"> {
    const accountId = this.generateAccountId();
    const outcome = await this.writer.finalizeDeviceAuthorizationCreate({
      authorization: transaction,
      accountId,
      externalAccountId: identity,
      credential: connection.credential,
      credentialSchemaVersion: adapter.credentialSchemaVersion,
      accessTokenExpiresAt: connection.accessTokenExpiresAt ?? null,
      now,
    });
    return outcome.type;
  }

  private async reconnect(
    transaction: ProcessingProviderAuthorization,
    snapshot: ModelProviderAccountLifecycleSnapshot,
    connection: ProviderConnectionResult<unknown>,
    adapter: ModelProviderAccountAdapter<unknown, unknown>,
    now: number
  ): Promise<boolean> {
    const { account } = snapshot;
    const outcome = await this.writer.finalizeDeviceAuthorizationReconnect({
      authorization: transaction,
      accountId: account.id,
      externalAccountId: account.externalAccountId,
      credential: connection.credential,
      credentialSchemaVersion: adapter.credentialSchemaVersion,
      accessTokenExpiresAt: connection.accessTokenExpiresAt ?? null,
      now,
    });
    return outcome.type === "connected";
  }
}
