import type {
  ProviderAuthorizationCodeStatusResponse,
  StartProviderAuthorizationCodeRequest,
  StartProviderAuthorizationCodeResponse,
} from "@open-inspect/shared/types/provider-accounts";
import {
  ProviderAuthorizationCodeExchangeError,
  type ErasedProviderAuthorizationCodeCapability,
  type ModelProviderAccountAdapterRegistry,
  type ProviderAuthorizationCodeExchangeClassification,
  type ProviderConnectionResult,
} from "../auth/model-provider-account-adapters";
import {
  decryptProviderAuthorizationPayload,
  encryptProviderAuthorizationPayload,
} from "../auth/provider-account-crypto";
import type {
  ProcessingProviderAuthorization,
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

const KIND = "authorization_code";
/**
 * A provider that refuses to look at the code (throttling) leaves it usable:
 * the transaction returns to pending so the user can paste again. After this
 * many such attempts the transaction fails closed.
 */
const MAX_EXCHANGE_ATTEMPTS = 3;
/**
 * The pasted code is exchanged synchronously, so the row never waits on a
 * poll interval; the schema still requires a positive interval on live rows.
 */
const EXCHANGE_INTERVAL_MS = 1000;
const AMBIGUOUS_EXCHANGE_MESSAGE =
  "The provider did not confirm the exchange, so the code may already have been used. Start a fresh authorization.";

/** What an authorization-code row keeps encrypted between start and complete. */
interface PersistedAuthorizationCodeState {
  providerState: unknown;
  exchangeAttempts: number;
}

function classifyExchangeFailure(
  cause: unknown
): ProviderAuthorizationCodeExchangeClassification | "unknown" {
  return cause instanceof ProviderAuthorizationCodeExchangeError ? cause.classification : "unknown";
}

export type ProviderAuthorizationCodeTransactionStore = Pick<
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
export type ProviderAuthorizationCodeAccountStore = Pick<
  ModelProviderAccountStore,
  "getLifecycleSnapshot" | "getById"
>;
export type ProviderAuthorizationCodeConnectionFinalizer = Pick<
  ProviderDeviceAuthorizationFinalizer,
  "finalizeTrustedConnection"
>;

export class ProviderAuthorizationCodeService {
  constructor(
    private readonly transactions: ProviderAuthorizationCodeTransactionStore,
    private readonly accounts: ProviderAuthorizationCodeAccountStore,
    private readonly finalizer: ProviderAuthorizationCodeConnectionFinalizer,
    private readonly encryptionKey: string,
    private readonly adapters: ModelProviderAccountAdapterRegistry,
    private readonly dependencies: { generateId: (bytes: number) => string; now: () => number },
    private readonly logger: Pick<Logger, "error">
  ) {}

  async start(
    userId: string,
    provider: ModelProviderId,
    input: StartProviderAuthorizationCodeRequest
  ): Promise<StartProviderAuthorizationCodeResponse> {
    const capability = this.capability(provider);
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
      const providerExpiresAt = started.expiresInMs ? activatedAt + started.expiresInMs : expiresAt;
      const effectiveExpiresAt = Math.min(expiresAt, providerExpiresAt);
      const encrypted = await this.encryptState(id, provider, capability.stateSchemaVersion, {
        providerState: started.providerState,
        exchangeAttempts: 0,
      });
      const activated = await this.transactions.activate(
        id,
        userId,
        encrypted,
        capability.stateSchemaVersion,
        EXCHANGE_INTERVAL_MS,
        effectiveExpiresAt,
        activatedAt,
        // The code can be pasted back the moment the consent page shows it.
        activatedAt
      );
      if (!activated) {
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
        authorizationUrl: started.authorizationUrl,
        expiresAt: effectiveExpiresAt,
        expiresInMs: effectiveExpiresAt - activatedAt,
      };
    } catch (cause) {
      await this.transactions.finish(id, userId, "failed", this.dependencies.now());
      if (cause instanceof ProviderAuthorizationError) throw cause;
      throw new ProviderAuthorizationError("Unable to start provider authorization", 502, true);
    }
  }

  /** Durable state only; the provider is never contacted here. */
  async status(
    userId: string,
    provider: ModelProviderId,
    id: string
  ): Promise<ProviderAuthorizationCodeStatusResponse> {
    const now = this.dependencies.now();
    const row = await this.resolveDurableRow(userId, provider, id, now);
    if (row.state === "processing" && isClaimStale(row, now)) {
      return this.finishAndResolve(userId, provider, id, "failed", now, row.processingOwner);
    }
    return this.respond(row);
  }

  /**
   * Exchange the pasted code exactly once. A transaction that already
   * reached a verdict replays it; one that is mid-exchange elsewhere refuses.
   */
  async complete(
    userId: string,
    provider: ModelProviderId,
    id: string,
    pastedCode: string
  ): Promise<ProviderAuthorizationCodeStatusResponse> {
    let now = this.dependencies.now();
    const current = await this.resolveDurableRow(userId, provider, id, now);
    if (current.state === "connected" || isTerminalAuthorization(current)) {
      return this.respond(current);
    }
    if (current.state === "processing" && isClaimStale(current, now)) {
      return this.finishAndResolve(userId, provider, id, "failed", now, current.processingOwner);
    }
    if (current.state !== "pending") throw this.completionInProgress();

    const owner = this.dependencies.generateId(32);
    const row = await this.transactions.claim(id, userId, owner, now);
    if (!row) {
      const settled = await this.resolveDurableRow(userId, provider, id, now);
      if (settled.state === "connected" || isTerminalAuthorization(settled)) {
        return this.respond(settled);
      }
      throw this.completionInProgress();
    }

    let persisted: PersistedAuthorizationCodeState;
    let connection: ProviderConnectionResult<unknown>;
    try {
      persisted = await decryptProviderAuthorizationPayload<PersistedAuthorizationCodeState>(
        row.encryptedProviderData,
        this.encryptionKey,
        { transactionId: id, provider, stateSchemaVersion: row.providerStateVersion }
      );
    } catch (cause) {
      return this.failClosed(userId, provider, row, cause);
    }
    try {
      connection = await this.capability(provider).completePersisted(
        persisted.providerState,
        row.providerStateVersion,
        pastedCode
      );
    } catch (cause) {
      return this.exchangeFailed(userId, provider, row, persisted, cause);
    }

    try {
      now = this.dependencies.now();
      const finalized = await this.finalizer.finalizeTrustedConnection(
        row,
        connection,
        this.adapters.require(provider),
        now
      );
      if (!finalized) {
        return this.finishAndResolve(userId, provider, id, "failed", now, owner);
      }
      return this.resolveDurableResponse(userId, provider, id, now);
    } catch (cause) {
      return this.failClosed(userId, provider, row, cause);
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

  private capability(provider: ModelProviderId): ErasedProviderAuthorizationCodeCapability {
    try {
      return this.adapters.requireAuthorizationCode(provider);
    } catch {
      throw new ProviderAuthorizationError(
        `Authorization-code connection is unavailable for ${provider}`,
        409
      );
    }
  }

  /**
   * A rejection is the provider's verdict on this code and ends the
   * transaction as denied. An ambiguous failure may have consumed the
   * one-use code, so the transaction fails and the user starts over. Only a
   * failure that never reached the code returns the row to pending.
   */
  private async exchangeFailed(
    userId: string,
    provider: ModelProviderId,
    row: ProcessingProviderAuthorization,
    persisted: PersistedAuthorizationCodeState,
    cause: unknown
  ): Promise<ProviderAuthorizationCodeStatusResponse> {
    const classification = classifyExchangeFailure(cause);
    if (classification === "unknown") return this.failClosed(userId, provider, row, cause);
    const now = this.dependencies.now();
    if (classification === "rejected") {
      await this.transactions.finish(row.id, userId, "denied", now, row.processingOwner);
      const settled = await this.resolveDurableRow(userId, provider, row.id, now);
      if (settled.state === "denied") {
        return terminalAuthorizationStatus("denied", (cause as Error).message);
      }
      return this.respond(settled);
    }
    if (classification === "ambiguous") {
      this.logger.error("provider_authorization_code.exchange_ambiguous", {
        transaction_id: row.id,
        provider,
        error: cause instanceof Error ? cause : String(cause),
      });
      await this.transactions.finish(row.id, userId, "failed", now, row.processingOwner);
      const settled = await this.resolveDurableRow(userId, provider, row.id, now);
      if (settled.state === "failed") {
        return terminalAuthorizationStatus("failed", AMBIGUOUS_EXCHANGE_MESSAGE);
      }
      return this.respond(settled);
    }

    const exchangeAttempts = persisted.exchangeAttempts + 1;
    if (exchangeAttempts >= MAX_EXCHANGE_ATTEMPTS) {
      this.logger.error("provider_authorization_code.exchange_exhausted", {
        transaction_id: row.id,
        provider,
        attempts: exchangeAttempts,
        error: cause instanceof Error ? cause : String(cause),
      });
      return this.finishAndResolve(userId, provider, row.id, "failed", now, row.processingOwner);
    }
    const encrypted = await this.encryptState(row.id, provider, row.providerStateVersion, {
      ...persisted,
      exchangeAttempts,
    });
    const returned = await this.transactions.returnPending(
      row,
      now,
      EXCHANGE_INTERVAL_MS,
      now,
      encrypted
    );
    if (!returned) return this.resolveDurableResponse(userId, provider, row.id, now);
    throw new ProviderAuthorizationError(
      "The provider asked us to slow down before exchanging the code; paste it again in a moment",
      503,
      true
    );
  }

  private async failClosed(
    userId: string,
    provider: ModelProviderId,
    row: ProcessingProviderAuthorization,
    cause: unknown
  ): Promise<ProviderAuthorizationCodeStatusResponse> {
    this.logger.error("provider_authorization_code.complete_failed", {
      transaction_id: row.id,
      provider,
      error: cause instanceof Error ? cause : String(cause),
    });
    return this.finishAndResolve(
      userId,
      provider,
      row.id,
      "failed",
      this.dependencies.now(),
      row.processingOwner
    );
  }

  private completionInProgress(): ProviderAuthorizationError {
    return new ProviderAuthorizationError(
      "This authorization is already being completed",
      409,
      true
    );
  }

  private encryptState(
    transactionId: string,
    provider: ModelProviderId,
    stateSchemaVersion: number,
    state: PersistedAuthorizationCodeState
  ): Promise<string> {
    return encryptProviderAuthorizationPayload(state, this.encryptionKey, {
      transactionId,
      provider,
      stateSchemaVersion,
    });
  }

  private async finishAndResolve(
    userId: string,
    provider: ModelProviderId,
    id: string,
    state: ProviderAuthorizationTerminalState,
    now: number,
    owner?: string
  ): Promise<ProviderAuthorizationCodeStatusResponse> {
    await this.transactions.finish(id, userId, state, now, owner);
    return this.resolveDurableResponse(userId, provider, id, now);
  }

  private async resolveDurableResponse(
    userId: string,
    provider: ModelProviderId,
    id: string,
    now: number
  ): Promise<ProviderAuthorizationCodeStatusResponse> {
    return this.respond(await this.resolveDurableRow(userId, provider, id, now));
  }

  private resolveDurableRow(
    userId: string,
    provider: ModelProviderId,
    id: string,
    now: number
  ): Promise<ProviderAuthorization> {
    return resolveDurableAuthorization(this.transactions, userId, provider, KIND, id, now);
  }

  private respond(row: ProviderAuthorization): Promise<ProviderAuthorizationCodeStatusResponse> {
    if (row.state === "connected") return connectedAuthorizationStatus(this.accounts, row);
    if (isTerminalAuthorization(row)) {
      return Promise.resolve(terminalAuthorizationStatus(row.state));
    }
    return Promise.resolve(this.pending(row));
  }

  private pending(row: ProviderAuthorizationLive): ProviderAuthorizationCodeStatusResponse {
    return { status: "pending", expiresAt: row.expiresAt };
  }
}
