import {
  PROVIDER_DEVICE_AUTHORIZATION_MAX_POLL_INTERVAL_MS,
  PROVIDER_DEVICE_AUTHORIZATION_MIN_POLL_INTERVAL_MS,
  type ProviderDeviceAuthorizationStatusResponse,
  type StartProviderDeviceAuthorizationRequest,
  type StartProviderDeviceAuthorizationResponse,
} from "@open-inspect/shared/types/provider-accounts";
import {
  decryptProviderAuthorizationPayload,
  encryptProviderAuthorizationPayload,
} from "../auth/provider-account-crypto";
import type { ModelProviderAccountAdapterRegistry } from "../auth/model-provider-account-adapters";
import type {
  ProviderAccountAuthorizationStore,
  ProviderAuthorization,
  ProviderAuthorizationLive,
  ProviderAuthorizationTerminalState,
} from "../db/provider-account-authorizations";
import type { ModelProviderAccountStore } from "../db/model-provider-accounts";
import type { Logger } from "../logger";
import type { ModelProviderId } from "./provider-auth-contracts";
import type { ProviderDeviceAuthorizationFinalizer } from "./device-authorization-finalizer";
import {
  ProviderAuthorizationError,
  cancelAuthorization,
  connectedAuthorizationStatus,
  isClaimStale,
  isTerminalAuthorization,
  reserveAuthorization,
  resolveDurableAuthorization,
  terminalAuthorizationStatus,
} from "./authorization-transaction";

const KIND = "device";

function boundedPollInterval(intervalMs: number): number {
  return Math.min(
    PROVIDER_DEVICE_AUTHORIZATION_MAX_POLL_INTERVAL_MS,
    Math.max(PROVIDER_DEVICE_AUTHORIZATION_MIN_POLL_INTERVAL_MS, intervalMs)
  );
}

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
      throw new ProviderAuthorizationError(
        `Device authorization is unavailable for ${provider}`,
        409
      );
    }
    const { id, expiresAt } = await reserveAuthorization(
      this.transactions,
      this.accounts,
      this.dependencies,
      userId,
      provider,
      KIND,
      input
    );

    try {
      const started = await capability.start();
      const activatedAt = this.dependencies.now();
      const pollIntervalMs = boundedPollInterval(started.intervalMs);
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
          pollIntervalMs,
          effectiveExpiresAt,
          activatedAt
        ))
      ) {
        throw new ProviderAuthorizationError(
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
        pollIntervalMs,
      };
    } catch (cause) {
      await this.transactions.finish(id, userId, "failed", this.dependencies.now());
      if (cause instanceof ProviderAuthorizationError) throw cause;
      throw new ProviderAuthorizationError("Unable to start provider authorization", 502, true);
    }
  }

  async poll(
    userId: string,
    provider: ModelProviderId,
    id: string
  ): Promise<ProviderDeviceAuthorizationStatusResponse> {
    let row = await this.resolveDurableRow(userId, provider, id, this.dependencies.now());
    let now = this.dependencies.now();
    if (row.state === "connected") return connectedAuthorizationStatus(this.accounts, row);
    if (this.isTerminal(row)) return this.terminal(row.state);
    if (row.state === "processing") {
      if (isClaimStale(row, now)) {
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
        const intervalMs = boundedPollInterval(result.intervalMs ?? row.intervalMs);
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

  cancel(userId: string, provider: ModelProviderId, id: string): Promise<void> {
    return cancelAuthorization(
      this.transactions,
      userId,
      provider,
      KIND,
      id,
      this.dependencies.now()
    );
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
    if (current.state === "connected") return connectedAuthorizationStatus(this.accounts, current);
    if (this.isTerminal(current)) return this.terminal(current.state);
    return this.pending(current);
  }

  private resolveDurableRow(
    userId: string,
    provider: ModelProviderId,
    id: string,
    now: number
  ): Promise<ProviderAuthorization> {
    return resolveDurableAuthorization(this.transactions, userId, provider, KIND, id, now);
  }

  private pending(row: ProviderAuthorizationLive): ProviderDeviceAuthorizationStatusResponse {
    return {
      status: "pending",
      expiresAt: row.expiresAt,
      // Initiating reservations have interval 0 until provider activation completes.
      pollIntervalMs: boundedPollInterval(row.intervalMs),
      nextPollAt: row.nextPollAt,
    };
  }

  private isTerminal(
    row: ProviderAuthorization
  ): row is Extract<ProviderAuthorization, { state: ProviderAuthorizationTerminalState }> {
    return isTerminalAuthorization(row);
  }

  private terminal(
    state: ProviderAuthorizationTerminalState
  ): ProviderDeviceAuthorizationStatusResponse {
    return terminalAuthorizationStatus(state);
  }
}
