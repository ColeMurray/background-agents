import type {
  ModelProviderAccount,
  ModelProviderAccountStore,
} from "../db/model-provider-accounts";
import type {
  ProviderCredentialState,
  ProviderCredentialStore,
} from "../db/provider-account-credentials";
import type { ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import { ProviderRefreshError } from "./model-provider-account-adapters";
import type {
  ModelProviderAccountAdapter,
  ModelProviderAccountAdapterRegistry,
} from "./model-provider-account-adapters";
import {
  ClaimedProviderCredentialExchange,
  ClaimedProviderCredentialExchangeError,
} from "./claimed-provider-credential-exchange";
import { providerAccountIneligibility } from "../model-provider-accounts/account-lifecycle-policy";

type ErasedProviderAccountAdapter = ModelProviderAccountAdapter<unknown, unknown>;

const LAST_USED_WRITE_INTERVAL_MS = 15 * 60 * 1000;
const DEFAULT_EXCHANGE_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_DELAY_MS = 100;

export interface ProviderAccess {
  accessToken: string;
  expiresIn?: number;
  externalAccountId?: string;
  providerMetadata?: Record<string, string>;
}

export type ModelProviderAccountBrokerErrorCode =
  | "account_not_found"
  | "account_inactive"
  | "account_archived"
  | "provider_mismatch"
  | "provider_unavailable"
  | "credential_not_found"
  | "credential_invalid"
  | "exchange_busy"
  | "reconnect_required"
  | "upstream_retry_safe";

export class ModelProviderAccountBrokerError extends Error {
  constructor(
    readonly code: ModelProviderAccountBrokerErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

export interface ModelProviderAccountBrokerStores {
  accounts: Pick<ModelProviderAccountStore, "getById" | "touchLastUsed">;
  credentials: Pick<
    ProviderCredentialStore,
    "readCredentialState" | "tryBeginExchange" | "completeExchange" | "clearSafeFailure"
  >;
  atomicWriter: Pick<ModelProviderAccountAtomicWriter, "fenceExchangeAndRequireReconnect">;
}

interface BrokerOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  createOwner?: () => string;
  exchangeTimeoutMs?: number;
  maxPollAttempts?: number;
  pollDelayMs?: number;
}

export class ModelProviderAccountBroker {
  private readonly inFlight = new Map<string, Promise<ProviderAccess>>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly createOwner: () => string;
  private readonly exchangeTimeoutMs: number;
  private readonly maxPollAttempts: number;
  private readonly pollDelayMs: number;
  private readonly exchange: ClaimedProviderCredentialExchange;

  constructor(
    private readonly stores: ModelProviderAccountBrokerStores,
    private readonly registry: ModelProviderAccountAdapterRegistry,
    options: BrokerOptions = {}
  ) {
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.createOwner = options.createOwner ?? (() => crypto.randomUUID());
    this.exchangeTimeoutMs = options.exchangeTimeoutMs ?? DEFAULT_EXCHANGE_TIMEOUT_MS;
    this.pollDelayMs = options.pollDelayMs ?? DEFAULT_POLL_DELAY_MS;
    this.maxPollAttempts =
      options.maxPollAttempts ?? Math.ceil(this.exchangeTimeoutMs / this.pollDelayMs) + 1;
    this.exchange = new ClaimedProviderCredentialExchange(
      stores.credentials,
      stores.atomicWriter.fenceExchangeAndRequireReconnect.bind(stores.atomicWriter)
    );
  }

  async getAccess(accountId: string, expectedProvider: ModelProviderId): Promise<ProviderAccess> {
    const account = await this.requireUsableAccount(accountId, expectedProvider);
    const adapter = this.registry.get(expectedProvider);
    if (!adapter) {
      throw new ModelProviderAccountBrokerError(
        "provider_unavailable",
        `Provider account adapter unavailable for ${expectedProvider}`
      );
    }
    const state = await this.readState(accountId, expectedProvider);
    const credential = this.parseCredential(adapter, state);
    const cached = adapter.cachedAccess(credential);
    if (cached && cached.accessTokenExpiresAt - this.now() > adapter.refreshBufferMs) {
      await this.touchLastUsed(account);
      return this.toAccess(account, adapter, credential, cached);
    }

    const key = `${accountId}:${state.credentialVersion}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const promise = this.refreshWithClaim(account, adapter, state).finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  private async refreshWithClaim(
    account: ModelProviderAccount & { status: "active" },
    adapter: ErasedProviderAccountAdapter,
    initialState: ProviderCredentialState
  ): Promise<ProviderAccess> {
    let state = initialState;
    for (let attempt = 0; attempt < this.maxPollAttempts; attempt++) {
      const credential = this.parseCredential(adapter, state);
      const cached = adapter.cachedAccess(credential);
      if (cached && cached.accessTokenExpiresAt - this.now() > adapter.refreshBufferMs) {
        await this.touchLastUsed(account);
        return this.toAccess(account, adapter, credential, cached);
      }

      if (state.exchangeState === "in_flight") {
        const stale =
          state.exchangeStartedAt === null ||
          this.now() - state.exchangeStartedAt >= this.exchangeTimeoutMs;
        if (stale) {
          let fenced: boolean;
          try {
            fenced = await this.stores.atomicWriter.fenceExchangeAndRequireReconnect({
              providerAccountId: account.id,
              credentialVersion: state.credentialVersion,
              exchangeGeneration: state.exchangeGeneration,
              exchangeOwner: state.exchangeOwner ?? "",
              now: this.now(),
            });
          } catch (cause) {
            return this.reconcileLostTerminalFence(account, adapter, state, cause);
          }
          if (fenced) {
            throw this.reconnectError(account.provider, "A credential exchange became stale");
          }
          return this.reconcileLostTerminalFence(account, adapter, state);
        }
        await this.sleep(this.pollDelayMs);
        state = await this.readState(account.id, account.provider);
        continue;
      }

      try {
        const result = await this.exchange.run({
          providerAccountId: account.id,
          provider: account.provider,
          state,
          expectedAccountStatus: account.status,
          adapter,
          owner: this.createOwner(),
          now: this.now,
          complete: ({ write, refreshed }) => {
            adapter.validateExternalIdentity(
              refreshed.externalAccountId,
              account.externalAccountId
            );
            return this.stores.credentials.completeExchange(write);
          },
        });
        if (result.kind === "claim_unavailable") {
          await this.sleep(this.pollDelayMs);
          state = await this.readState(account.id, account.provider);
          continue;
        }
        await this.touchLastUsed(account);
        return this.toAccess(account, adapter, result.refreshed.credential, {
          accessToken: result.refreshed.accessToken,
          accessTokenExpiresAt: result.refreshed.accessTokenExpiresAt,
        });
      } catch (error) {
        if (!(error instanceof ClaimedProviderCredentialExchangeError)) throw error;
        if (error.phase === "parse") {
          throw new ModelProviderAccountBrokerError(
            "credential_invalid",
            `Stored ${adapter.provider} credential is invalid`,
            { cause: error.cause }
          );
        }
        if (
          error.phase === "refresh" &&
          error.cause instanceof ProviderRefreshError &&
          error.cause.classification === "retry_safe"
        ) {
          throw new ModelProviderAccountBrokerError(
            "upstream_retry_safe",
            `${account.provider} credential refresh failed safely`,
            { cause: error.cause }
          );
        }
        if (error.terminalFence === "lost") {
          return this.reconcileLostTerminalFence(account, adapter, state);
        }
        const reread = await this.readState(account.id, account.provider);
        if (reread.credentialVersion !== state.credentialVersion) {
          return this.accessFromConcurrentUpdate(account, adapter, reread);
        }
        throw this.reconnectError(
          account.provider,
          error.phase === "completion"
            ? "Refreshed credentials could not be persisted"
            : "Credential refresh requires reconnection",
          error.cause
        );
      }
    }
    throw new ModelProviderAccountBrokerError(
      "exchange_busy",
      `${account.provider} credential exchange did not complete`
    );
  }

  private accessFromConcurrentUpdate(
    account: ModelProviderAccount,
    adapter: ErasedProviderAccountAdapter,
    state: ProviderCredentialState
  ): ProviderAccess {
    const credential = this.parseCredential(adapter, state);
    const cached = adapter.cachedAccess(credential);
    if (!cached || cached.accessTokenExpiresAt - this.now() <= adapter.refreshBufferMs) {
      throw this.reconnectError(
        account.provider,
        "Concurrent credential replacement has no usable access token"
      );
    }
    return this.toAccess(account, adapter, credential, cached);
  }

  private parseCredential(
    adapter: ErasedProviderAccountAdapter,
    state: ProviderCredentialState
  ): unknown {
    try {
      return adapter.parseCredential(state.payload, state.credentialSchemaVersion);
    } catch (error) {
      throw new ModelProviderAccountBrokerError(
        "credential_invalid",
        `Stored ${adapter.provider} credential is invalid`,
        { cause: error }
      );
    }
  }

  private async requireUsableAccount(
    accountId: string,
    expectedProvider: ModelProviderId
  ): Promise<ModelProviderAccount & { status: "active" }> {
    const account = await this.stores.accounts.getById(accountId);
    if (!account) {
      throw new ModelProviderAccountBrokerError("account_not_found", "Provider account not found");
    }
    if (account.provider !== expectedProvider) {
      throw new ModelProviderAccountBrokerError(
        "provider_mismatch",
        `Provider account does not belong to ${expectedProvider}`
      );
    }
    const ineligibility = providerAccountIneligibility(account, "active_use");
    if (ineligibility === "archived") {
      throw new ModelProviderAccountBrokerError("account_archived", "Provider account is archived");
    }
    if (ineligibility) {
      throw new ModelProviderAccountBrokerError(
        "account_inactive",
        `Provider account is ${account.status}`
      );
    }
    return { ...account, status: "active" };
  }

  private async reconcileLostTerminalFence(
    previousAccount: ModelProviderAccount,
    adapter: ErasedProviderAccountAdapter,
    previousState: ProviderCredentialState,
    fenceError?: unknown
  ): Promise<ProviderAccess> {
    const account = await this.stores.accounts.getById(previousAccount.id);
    if (!account) {
      throw new ModelProviderAccountBrokerError("account_not_found", "Provider account not found");
    }
    if (account.provider !== previousAccount.provider) {
      throw new ModelProviderAccountBrokerError(
        "provider_mismatch",
        `Provider account does not belong to ${previousAccount.provider}`
      );
    }
    const ineligibility = providerAccountIneligibility(account, "active_use");
    if (ineligibility === "archived") {
      throw new ModelProviderAccountBrokerError("account_archived", "Provider account is archived");
    }
    if (ineligibility === "reconnect_required") {
      throw this.reconnectError(account.provider, "Credential refresh requires reconnection");
    }
    if (ineligibility) {
      throw new ModelProviderAccountBrokerError(
        "account_inactive",
        `Provider account is ${account.status}`
      );
    }

    const state = await this.readState(account.id, account.provider);
    if (state.credentialVersion !== previousState.credentialVersion) {
      return this.accessFromConcurrentUpdate(account, adapter, state);
    }
    if (fenceError !== undefined) throw fenceError;
    throw new ModelProviderAccountBrokerError(
      "exchange_busy",
      `${account.provider} credential exchange lost its durable claim`
    );
  }

  private async readState(
    accountId: string,
    provider: ModelProviderId
  ): Promise<ProviderCredentialState> {
    const state = await this.stores.credentials.readCredentialState(accountId, provider);
    if (!state) {
      throw new ModelProviderAccountBrokerError(
        "credential_not_found",
        "Provider account credential not found"
      );
    }
    return state;
  }

  private toAccess(
    account: ModelProviderAccount,
    adapter: ErasedProviderAccountAdapter,
    credential: unknown,
    cached: { accessToken: string; accessTokenExpiresAt: number }
  ): ProviderAccess {
    const expiresIn = Math.max(0, Math.floor((cached.accessTokenExpiresAt - this.now()) / 1000));
    return {
      accessToken: cached.accessToken,
      expiresIn,
      ...(account.externalAccountId ? { externalAccountId: account.externalAccountId } : {}),
      providerMetadata: adapter.runtimeMetadata(credential, account.externalAccountId),
    };
  }

  private async touchLastUsed(account: ModelProviderAccount): Promise<void> {
    try {
      await this.stores.accounts.touchLastUsed(
        account.id,
        this.now() - LAST_USED_WRITE_INTERVAL_MS,
        this.now()
      );
    } catch {
      // Usage attribution must not invalidate already-persisted authentication state.
    }
  }

  private reconnectError(provider: ModelProviderId, message: string, cause?: unknown) {
    return new ModelProviderAccountBrokerError(
      "reconnect_required",
      `${provider}: ${message}`,
      cause === undefined ? undefined : { cause }
    );
  }
}
