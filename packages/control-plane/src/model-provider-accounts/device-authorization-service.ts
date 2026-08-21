import type {
  ModelProviderAccountStatus,
  ProviderDeviceAuthorizationStatusResponse,
  StartProviderDeviceAuthorizationRequest,
  StartProviderDeviceAuthorizationResponse,
} from "@open-inspect/shared/types/provider-accounts";
import {
  decryptProviderAuthorizationPayload,
  encryptProviderAuthorizationPayload,
} from "../auth/provider-account-crypto";
import type { ModelProviderAccountAdapterRegistry } from "../auth/model-provider-account-adapters";
import {
  PROVIDER_AUTHORIZATION_LIVE_STATES,
  PROVIDER_AUTHORIZATION_TERMINAL_STATES,
  type ProviderAccountAuthorizationStore,
  type ConnectedProviderAuthorization,
  type ProviderAuthorization,
  type ProviderAuthorizationLive,
  type ProviderAuthorizationLiveState,
  type ProviderAuthorizationTerminalState,
} from "../db/provider-account-authorizations";
import type { ModelProviderAccountStore } from "../db/model-provider-accounts";
import type { Logger } from "../logger";
import type { ModelProviderId } from "./provider-auth-contracts";
import type { ProviderDeviceAuthorizationFinalizer } from "./device-authorization-finalizer";

const TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;
const PROCESSING_CLAIM_TIMEOUT_MS = 30 * 1000;

export type ProviderDeviceAuthorizationTransactionStore = Pick<
  ProviderAccountAuthorizationStore,
  | "recordAttempt"
  | "reserve"
  | "activate"
  | "getOwned"
  | "claim"
  | "returnPending"
  | "finish"
  | "expire"
>;
export type ProviderDeviceAuthorizationAccountStore = Pick<
  ModelProviderAccountStore,
  "getLifecycleSnapshot" | "getById"
>;
export type ProviderDeviceAuthorizationConnectionFinalizer = Pick<
  ProviderDeviceAuthorizationFinalizer,
  "finalizeTrustedConnection"
>;

export class ProviderDeviceAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false
  ) {
    super(message);
  }
}

export class ProviderDeviceAuthorizationService {
  constructor(
    private readonly transactions: ProviderDeviceAuthorizationTransactionStore,
    private readonly accounts: ProviderDeviceAuthorizationAccountStore,
    private readonly finalizer: ProviderDeviceAuthorizationConnectionFinalizer,
    private readonly encryptionKey: string,
    private readonly adapters: ModelProviderAccountAdapterRegistry,
    private readonly dependencies: { generateId: (bytes: number) => string; now: () => number },
    private readonly logger: Pick<Logger, "error">
  ) {}

  async start(
    userId: string,
    provider: ModelProviderId,
    input: StartProviderDeviceAuthorizationRequest
  ): Promise<StartProviderDeviceAuthorizationResponse> {
    let capability;
    try {
      capability = this.adapters.requireDeviceAuthorization(provider);
    } catch {
      throw new ProviderDeviceAuthorizationError(
        `Device authorization is unavailable for ${provider}`,
        409
      );
    }
    let targetAccountStatus: ModelProviderAccountStatus | null = null;
    let targetAccountLifecycleVersion: number | null = null;
    if (input.operation === "reconnect") {
      const snapshot = await this.accounts.getLifecycleSnapshot(input.providerAccountId);
      if (!snapshot) throw new ProviderDeviceAuthorizationError("Provider account not found", 404);
      const { account, lifecycleVersion } = snapshot;
      if (account.provider !== provider) {
        throw new ProviderDeviceAuthorizationError("Provider account does not match provider", 400);
      }
      if (account.archivedAt !== null) {
        throw new ProviderDeviceAuthorizationError("Provider account is archived", 409);
      }
      targetAccountStatus = account.status;
      targetAccountLifecycleVersion = lifecycleVersion;
    }

    const now = this.dependencies.now();
    const id = this.dependencies.generateId(32);
    const attemptId = this.dependencies.generateId(32);
    if (!(await this.transactions.recordAttempt(attemptId, userId, now))) {
      throw new ProviderDeviceAuthorizationError(
        "Too many authorization attempts; try again shortly",
        429,
        true
      );
    }
    const expiresAt = now + TRANSACTION_LIFETIME_MS;
    const reserved = await this.transactions.reserve({
      id,
      userId,
      provider,
      operation: input.operation,
      providerAccountId: input.operation === "reconnect" ? input.providerAccountId : null,
      targetAccountStatus,
      targetAccountLifecycleVersion,
      displayName: input.operation === "create" ? input.displayName : null,
      expiresAt,
      now,
    });
    if (!reserved) {
      throw new ProviderDeviceAuthorizationError(
        "Too many live authorization attempts; finish or cancel one first",
        429,
        true
      );
    }

    try {
      const started = await capability.start();
      const activatedAt = this.dependencies.now();
      const providerExpiresAt = started.expiresInMs ? activatedAt + started.expiresInMs : expiresAt;
      const effectiveExpiresAt = Math.min(expiresAt, providerExpiresAt);
      const encrypted = await encryptProviderAuthorizationPayload(
        started.providerState,
        this.encryptionKey,
        { transactionId: id, provider, stateSchemaVersion: capability.stateSchemaVersion }
      );
      if (
        !(await this.transactions.activate(
          id,
          userId,
          encrypted,
          capability.stateSchemaVersion,
          started.intervalMs,
          effectiveExpiresAt,
          activatedAt
        ))
      ) {
        throw new ProviderDeviceAuthorizationError(
          "Authorization attempt was cancelled or superseded",
          409,
          true
        );
      }
      return {
        transactionId: id,
        provider,
        operation: input.operation,
        userCode: started.userCode,
        verificationUrl: started.verificationUrl,
        expiresAt: effectiveExpiresAt,
        expiresInMs: effectiveExpiresAt - activatedAt,
        pollIntervalMs: started.intervalMs,
      };
    } catch (cause) {
      await this.transactions.finish(id, userId, "failed", this.dependencies.now());
      if (cause instanceof ProviderDeviceAuthorizationError) throw cause;
      throw new ProviderDeviceAuthorizationError(
        "Unable to start provider authorization",
        502,
        true
      );
    }
  }

  async poll(
    userId: string,
    provider: ModelProviderId,
    id: string
  ): Promise<ProviderDeviceAuthorizationStatusResponse> {
    let row = await this.resolveDurableRow(userId, provider, id, this.dependencies.now());
    let now = this.dependencies.now();
    if (row.state === "connected") return this.connected(row);
    if (this.isTerminal(row)) return this.terminal(row.state);
    if (row.state === "processing") {
      if (row.processingStartedAt + PROCESSING_CLAIM_TIMEOUT_MS <= now) {
        return this.finishAndResolve(userId, provider, id, "failed", now, row.processingOwner);
      }
      return this.pending(row);
    }
    if (row.state === "initiating" || row.nextPollAt > now) return this.pending(row);

    const owner = this.dependencies.generateId(32);
    const claimed = await this.transactions.claim(id, userId, owner, now);
    if (!claimed) {
      return this.resolveDurableResponse(userId, provider, id, now);
    }
    row = claimed;
    try {
      const providerState = await decryptProviderAuthorizationPayload(
        row.encryptedProviderData,
        this.encryptionKey,
        {
          transactionId: id,
          provider,
          stateSchemaVersion: row.providerStateVersion,
        }
      );
      const capability = this.adapters.requireDeviceAuthorization(provider);
      const result = await capability.pollPersisted(
        providerState,
        row.providerStateVersion,
        row.intervalMs
      );
      now = this.dependencies.now();
      if (result.status === "pending") {
        const intervalMs = result.intervalMs ?? row.intervalMs;
        const nextPollAt = now + intervalMs;
        if (!(await this.transactions.returnPending(row, nextPollAt, intervalMs, now))) {
          return this.resolveDurableResponse(userId, provider, id, now);
        }
        return {
          status: "pending",
          expiresAt: row.expiresAt,
          pollIntervalMs: intervalMs,
          nextPollAt,
        };
      }
      if (result.status !== "connected") {
        return this.finishAndResolve(userId, provider, id, result.status, now, owner);
      }
      const finalized = await this.finalizer.finalizeTrustedConnection(
        row,
        result.connection,
        this.adapters.require(provider),
        now
      );
      if (!finalized) {
        return this.finishAndResolve(userId, provider, id, "failed", now, owner);
      }
      return this.resolveDurableResponse(userId, provider, id, now);
    } catch (cause) {
      this.logger.error("provider_device_authorization.poll_failed", {
        transaction_id: id,
        provider,
        error: cause instanceof Error ? cause : String(cause),
      });
      now = this.dependencies.now();
      return this.finishAndResolve(userId, provider, id, "failed", now, owner);
    }
  }

  async cancel(userId: string, provider: ModelProviderId, id: string): Promise<void> {
    const row = await this.owned(userId, provider, id);
    if (!this.isTerminal(row) && row.state !== "connected") {
      const now = this.dependencies.now();
      await this.finishAndResolve(userId, provider, id, "cancelled", now);
    }
  }

  private async finishAndResolve(
    userId: string,
    provider: ModelProviderId,
    id: string,
    state: ProviderAuthorizationTerminalState,
    now: number,
    owner?: string
  ): Promise<ProviderDeviceAuthorizationStatusResponse> {
    await this.transactions.finish(id, userId, state, now, owner);
    return this.resolveDurableResponse(userId, provider, id, now);
  }

  private async resolveDurableResponse(
    userId: string,
    provider: ModelProviderId,
    id: string,
    now: number
  ): Promise<ProviderDeviceAuthorizationStatusResponse> {
    const current = await this.resolveDurableRow(userId, provider, id, now);
    if (current.state === "connected") return this.connected(current);
    if (this.isTerminal(current)) return this.terminal(current.state);
    return this.pending(current);
  }

  private async resolveDurableRow(
    userId: string,
    provider: ModelProviderId,
    id: string,
    now: number
  ): Promise<ProviderAuthorization> {
    while (true) {
      const current = await this.owned(userId, provider, id);
      if (!this.isLive(current) || current.expiresAt > now) {
        return current;
      }
      await this.transactions.expire(current, now);
    }
  }

  private async owned(
    userId: string,
    provider: ModelProviderId,
    id: string
  ): Promise<ProviderAuthorization> {
    const row = await this.transactions.getOwned(userId, id);
    if (!row || row.provider !== provider) {
      throw new ProviderDeviceAuthorizationError("Authorization transaction not found", 404);
    }
    return row;
  }

  private async connected(
    row: ConnectedProviderAuthorization
  ): Promise<ProviderDeviceAuthorizationStatusResponse> {
    const account = await this.accounts.getById(row.resultProviderAccountId);
    if (!account) throw new ProviderDeviceAuthorizationError("Connected account not found", 409);
    return {
      status: "connected",
      account,
      reconnectedExisting: row.reconnectedExisting,
      completedAt: row.completedAt,
    };
  }

  private pending(row: ProviderAuthorizationLive): ProviderDeviceAuthorizationStatusResponse {
    return {
      status: "pending",
      expiresAt: row.expiresAt,
      // Initiating reservations have interval 0 until provider activation completes.
      pollIntervalMs: Math.max(row.intervalMs, 1_000),
      nextPollAt: row.nextPollAt,
    };
  }

  private isTerminal(
    row: ProviderAuthorization
  ): row is Extract<ProviderAuthorization, { state: ProviderAuthorizationTerminalState }> {
    return PROVIDER_AUTHORIZATION_TERMINAL_STATES.includes(
      row.state as ProviderAuthorizationTerminalState
    );
  }

  private isLive(row: ProviderAuthorization): row is ProviderAuthorizationLive {
    return PROVIDER_AUTHORIZATION_LIVE_STATES.includes(row.state as ProviderAuthorizationLiveState);
  }

  private terminal(
    state: ProviderAuthorizationTerminalState
  ): ProviderDeviceAuthorizationStatusResponse {
    const messages = {
      denied: "Provider authorization was denied.",
      expired: "Provider authorization expired.",
      failed: "Provider authorization failed. Start a fresh authorization.",
      cancelled: "Provider authorization was cancelled.",
      superseded: "A newer authorization attempt replaced this one.",
    } as const;
    return { status: state, error: messages[state], retryable: state !== "denied" };
  }
}
