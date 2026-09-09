import type {
  ModelProviderAccountStatus,
  ProviderAuthorizationCodeStatusResponse,
  StartProviderAuthorizationCodeRequest,
  StartProviderAuthorizationCodeResponse,
} from "@open-inspect/shared/types/provider-accounts";
import { AnthropicTokenExchangeError } from "../auth/anthropic";
import type {
  ErasedProviderAuthorizationCodeCapability,
  ModelProviderAccountAdapterRegistry,
  ProviderConnectionResult,
} from "../auth/model-provider-account-adapters";
import {
  decryptProviderAuthorizationPayload,
  encryptProviderAuthorizationPayload,
} from "../auth/provider-account-crypto";
import type {
  ConnectedProviderAuthorization,
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
  PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS,
  PROVIDER_AUTHORIZATION_TRANSACTION_LIFETIME_MS,
  ProviderAuthorizationError,
  isTerminalAuthorization,
  ownedAuthorization,
  resolveDurableAuthorization,
  terminalAuthorizationStatus,
} from "./authorization-transaction";

/**
 * Exchanges that fail without the provider answering (network, 5xx) return
 * the transaction to pending so the user can paste again; after this many
 * such attempts the transaction fails closed.
 */
const MAX_EXCHANGE_ATTEMPTS = 3;
/**
 * The pasted code is exchanged synchronously, so the row never waits on a
 * poll interval; the schema still requires a positive interval on live rows.
 */
const EXCHANGE_INTERVAL_MS = 1000;

/** What an authorization-code row keeps encrypted between start and complete. */
interface PersistedAuthorizationCodeState {
  providerState: unknown;
  exchangeAttempts: number;
}

type ExchangeFailureClass = "rejected" | "retry_safe" | "unknown";

/**
 * A rejection is the provider's verdict on this code (wrong state, used or
 * expired code, wrong scope): terminal, the user starts over. Everything
 * short of a verdict is retry-safe: the same pasted code can be exchanged
 * again.
 */
function classifyExchangeFailure(cause: unknown): ExchangeFailureClass {
  if (!(cause instanceof AnthropicTokenExchangeError)) return "unknown";
  switch (cause.reason) {
    case "invalid_grant":
    case "invalid_request":
    case "scope_mismatch":
    case "malformed_response":
      return "rejected";
    case "network":
    case "server_error":
      return "retry_safe";
  }
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
    let targetAccountStatus: ModelProviderAccountStatus | null = null;
    let targetAccountLifecycleVersion: number | null = null;
    if (input.operation === "reconnect") {
      const snapshot = await this.accounts.getLifecycleSnapshot(input.providerAccountId);
      if (!snapshot) throw new ProviderAuthorizationError("Provider account not found", 404);
      const { account, lifecycleVersion } = snapshot;
      if (account.provider !== provider) {
        throw new ProviderAuthorizationError("Provider account does not match provider", 400);
      }
      if (account.archivedAt !== null) {
        throw new ProviderAuthorizationError("Provider account is archived", 409);
      }
      targetAccountStatus = account.status;
      targetAccountLifecycleVersion = lifecycleVersion;
    }

    const now = this.dependencies.now();
    const id = this.dependencies.generateId(32);
    const attemptId = this.dependencies.generateId(32);
    if (!(await this.transactions.recordAttempt(attemptId, userId, now))) {
      throw new ProviderAuthorizationError(
        "Too many authorization attempts; try again shortly",
        429,
        true
      );
    }
    const expiresAt = now + PROVIDER_AUTHORIZATION_TRANSACTION_LIFETIME_MS;
    const reserved = await this.transactions.reserve({
      id,
      userId,
      provider,
      authorizationKind: "authorization_code",
      operation: input.operation,
      providerAccountId: input.operation === "reconnect" ? input.providerAccountId : null,
      targetAccountStatus,
      targetAccountLifecycleVersion,
      displayName: input.operation === "create" ? input.displayName : null,
      expiresAt,
      now,
    });
    if (!reserved) {
      throw new ProviderAuthorizationError(
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
    if (row.state === "processing" && this.claimIsStale(row, now)) {
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
    if (current.state === "processing" && this.claimIsStale(current, now)) {
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

  async cancel(userId: string, provider: ModelProviderId, id: string): Promise<void> {
    const row = await ownedAuthorization(this.transactions, userId, provider, id);
    if (!isTerminalAuthorization(row) && row.state !== "connected") {
      await this.finishAndResolve(userId, provider, id, "cancelled", this.dependencies.now());
    }
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
      "The provider could not be reached to exchange the code; paste it again",
      502,
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

  private claimIsStale(row: ProcessingProviderAuthorization, now: number): boolean {
    return row.processingStartedAt + PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS <= now;
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
    return resolveDurableAuthorization(this.transactions, userId, provider, id, now);
  }

  private respond(row: ProviderAuthorization): Promise<ProviderAuthorizationCodeStatusResponse> {
    if (row.state === "connected") return this.connected(row);
    if (isTerminalAuthorization(row)) {
      return Promise.resolve(terminalAuthorizationStatus(row.state));
    }
    return Promise.resolve(this.pending(row));
  }

  private async connected(
    row: ConnectedProviderAuthorization
  ): Promise<ProviderAuthorizationCodeStatusResponse> {
    const account = await this.accounts.getById(row.resultProviderAccountId);
    if (!account) throw new ProviderAuthorizationError("Connected account not found", 409);
    return {
      status: "connected",
      account,
      reconnectedExisting: row.reconnectedExisting,
      completedAt: row.completedAt,
    };
  }

  private pending(row: ProviderAuthorizationLive): ProviderAuthorizationCodeStatusResponse {
    return { status: "pending", expiresAt: row.expiresAt };
  }
}
