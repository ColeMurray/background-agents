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

  async finalizeTrustedConnection(
    transaction: ProcessingProviderAuthorization,
    connection: ProviderConnectionResult<unknown>,
    adapter: ModelProviderAccountAdapter<unknown, unknown>,
    now: number
  ): Promise<boolean> {
    const identity = connection.externalAccountId;
    if (!identity) throw new Error("Provider account identity could not be verified");
    const seat = connection.externalPrincipalId ?? null;

    if (transaction.operation === "reconnect") {
      const snapshot = await this.accounts.getLifecycleSnapshot(transaction.providerAccountId);
      const account = snapshot?.account;
      if (!account || account.archivedAt !== null || account.provider !== transaction.provider) {
        throw new Error("Provider account is unavailable for reconnection");
      }
      if (!account.externalAccountId || account.externalAccountId !== identity) {
        throw new Error("Provider account identity did not match");
      }
      // On a subscription with many seats the account id above matches for every member, so
      // without this a reconnect authorized by the wrong seat would overwrite this credential.
      if (account.externalPrincipalId !== null && account.externalPrincipalId !== seat) {
        throw new Error("Provider account identity did not match");
      }
      return this.reconnect(transaction, snapshot, connection, adapter, now);
    }

    const existing = await this.resolveConnectTarget(transaction.provider, identity, seat);
    if (existing) {
      if (existing.account.status === "disabled") {
        throw new Error("Provider account is unavailable for reconnection");
      }
      return this.reconnect(transaction, existing, connection, adapter, now);
    }

    const outcome = await this.create(transaction, connection, adapter, identity, seat, now);
    if (outcome !== "identity_conflict") return outcome === "created";

    // A concurrent create won the unique provider identity. Converge only on
    // that explicit writer outcome; encryption and database failures propagate.
    const winner = await this.resolveConnectTarget(transaction.provider, identity, seat);
    if (!winner) throw new Error("Provider identity conflict winner could not be read");
    if (winner.account.status === "disabled") {
      throw new Error("Provider account is unavailable for reconnection");
    }
    return this.reconnect(transaction, winner, connection, adapter, now);
  }

  /**
   * Find the account a connecting seat belongs to, if one already exists.
   *
   * Prefers the account already bound to this seat. Falls back to an account on the same
   * subscription whose seat was never recorded, which is what an installation upgraded from
   * before seats were tracked holds: that seat's first connection adopts the account instead of
   * creating a duplicate beside it. Two seats on one subscription share neither, so each gets
   * its own account.
   */
  private async resolveConnectTarget(
    provider: ProcessingProviderAuthorization["provider"],
    externalAccountId: string,
    seat: string | null
  ): Promise<ModelProviderAccountLifecycleSnapshot | null> {
    const bound = await this.accounts.findLifecycleSnapshotByExternalIdentity(
      provider,
      externalAccountId,
      seat
    );
    if (bound || seat === null) return bound;
    return this.accounts.findLifecycleSnapshotByExternalIdentity(provider, externalAccountId, null);
  }

  private async create(
    transaction: ProcessingProviderAuthorization & { operation: "create" },
    connection: ProviderConnectionResult<unknown>,
    adapter: ModelProviderAccountAdapter<unknown, unknown>,
    identity: string,
    seat: string | null,
    now: number
  ): Promise<"created" | "identity_conflict" | "claim_lost"> {
    const accountId = this.generateAccountId();
    const outcome = await this.writer.finalizeDeviceAuthorizationCreate({
      authorization: transaction,
      accountId,
      // Seats on one subscription would otherwise all carry the client's generic default name.
      displayName: connection.externalPrincipalLabel ?? transaction.displayName,
      externalAccountId: identity,
      externalPrincipalId: seat,
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
      externalAccountId: account.externalAccountId!,
      externalPrincipalId: connection.externalPrincipalId ?? null,
      credential: connection.credential,
      credentialSchemaVersion: adapter.credentialSchemaVersion,
      accessTokenExpiresAt: connection.accessTokenExpiresAt ?? null,
      now,
    });
    return outcome.type === "connected";
  }
}
