import type {
  ConnectModelProviderAccountRequest,
  ReconnectModelProviderAccountRequest,
} from "@open-inspect/shared/types/provider-accounts";
import type {
  ModelProviderAccount,
  ModelProviderAccountStatus,
  ModelProviderAccountStore,
} from "../db/model-provider-accounts";
import type {
  ProviderCredentialState,
  ProviderCredentialStore,
} from "../db/provider-account-credentials";
import type { ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import type { ModelProviderId } from "./provider-auth-contracts";
import {
  type ModelProviderAccountAdapter,
  type ModelProviderAccountAdapterRegistry,
  type ProviderConnectionResult,
  ProviderIdentityError,
  ProviderRefreshError,
} from "../auth/model-provider-account-adapters";
import {
  ClaimedProviderCredentialExchange,
  ClaimedProviderCredentialExchangeError,
} from "../auth/claimed-provider-credential-exchange";
import {
  providerAccountIneligibility,
  type ProviderAccountOperation,
} from "./account-lifecycle-policy";

type ErasedProviderAccountAdapter = ModelProviderAccountAdapter<unknown, unknown>;

export type ModelProviderAccountServiceAccountStore = Pick<
  ModelProviderAccountStore,
  "list" | "getById" | "findByExternalIdentity" | "updateDetails" | "setStatus" | "archive"
>;

export type ModelProviderAccountServiceCredentialStore = Pick<
  ProviderCredentialStore,
  "tryBeginExchange" | "clearSafeFailure"
> & {
  readCredentialState(
    providerAccountId: string,
    provider: ModelProviderId
  ): Promise<ProviderCredentialState | null>;
};

export class ProviderAccountServiceError extends Error {
  constructor(
    message: string,
    readonly status: number,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

function mapDefaultAccountConstraint(cause: unknown, message: string): never {
  if (
    !(cause instanceof Error) ||
    !/provider default account must remain active/i.test(cause.message)
  ) {
    throw cause;
  }
  throw new ProviderAccountServiceError(message, 409, { cause });
}

export class ModelProviderAccountService {
  private readonly exchange: ClaimedProviderCredentialExchange;

  constructor(
    private readonly accounts: ModelProviderAccountServiceAccountStore,
    private readonly credentials: ModelProviderAccountServiceCredentialStore,
    private readonly atomicWriter: ModelProviderAccountAtomicWriter,
    private readonly adapters: ModelProviderAccountAdapterRegistry,
    private readonly dependencies: { generateId: () => string; now: () => number }
  ) {
    this.exchange = new ClaimedProviderCredentialExchange(
      credentials,
      atomicWriter.fenceExchangeAndRequireReconnect.bind(atomicWriter)
    );
  }

  list(provider?: ModelProviderId, includeArchived = false): Promise<ModelProviderAccount[]> {
    return this.accounts.list(provider, includeArchived);
  }

  async get(id: string): Promise<ModelProviderAccount> {
    const account = await this.accounts.getById(id);
    if (!account) throw new ProviderAccountServiceError("Provider account not found", 404);
    return account;
  }

  async create(
    input: ConnectModelProviderAccountRequest,
    actorId: string
  ): Promise<{
    account: ModelProviderAccount;
    reconnectedExisting: boolean;
  }> {
    const adapter = this.requireAdapter(input.provider);
    const connected = await this.connect(adapter, input);
    const now = this.dependencies.now();
    const externalAccountId = connected.externalAccountId ?? null;
    let existing: ModelProviderAccount | null = null;
    if (externalAccountId) {
      try {
        existing = await this.accounts.findByExternalIdentity(input.provider, externalAccountId);
      } catch (cause) {
        throw this.consumedCredentialError(cause);
      }
    }
    if (existing) {
      return {
        account: await this.persistConnectedCredential(existing, connected, adapter, actorId, now),
        reconnectedExisting: true,
      };
    }

    try {
      const account = await this.atomicWriter.createAccountWithCredential({
        id: this.dependencies.generateId(),
        provider: input.provider,
        displayName: input.displayName,
        externalAccountId,
        actorId,
        now,
        credential: {
          credentialSchemaVersion: adapter.credentialSchemaVersion,
          payload: connected.credential,
          accessTokenExpiresAt: connected.accessTokenExpiresAt,
        },
      });
      return {
        account,
        reconnectedExisting: false,
      };
    } catch (cause) {
      // A concurrent create may win the unique provider identity; converge on that account.
      let winner: ModelProviderAccount | null = null;
      if (externalAccountId) {
        try {
          winner = await this.accounts.findByExternalIdentity(input.provider, externalAccountId);
        } catch {
          throw this.consumedCredentialError(cause);
        }
      }
      if (winner) {
        return {
          account: await this.persistConnectedCredential(winner, connected, adapter, actorId, now),
          reconnectedExisting: true,
        };
      }
      throw this.consumedCredentialError(cause);
    }
  }

  async rename(id: string, displayName: string, actorId: string): Promise<ModelProviderAccount> {
    const account = await this.accounts.getById(id);
    if (
      !account ||
      !(await this.accounts.updateDetails(id, {
        displayName,
        actorId,
        now: this.dependencies.now(),
      }))
    ) {
      throw new ProviderAccountServiceError("Provider account not found", 404);
    }
    return this.get(id);
  }

  async setStatus(
    id: string,
    status: Extract<ModelProviderAccountStatus, "active" | "disabled">,
    actorId: string
  ): Promise<ModelProviderAccount> {
    const account = await this.get(id);
    if (account.status === status) return account;
    if (status === "active" && account.status !== "disabled") {
      throw new ProviderAccountServiceError("Provider account requires reconnection", 409);
    }
    try {
      if (!(await this.accounts.setStatus(id, status, actorId, this.dependencies.now()))) {
        throw new ProviderAccountServiceError("Provider account not found", 404);
      }
    } catch (cause) {
      if (cause instanceof ProviderAccountServiceError) throw cause;
      mapDefaultAccountConstraint(cause, "A default account must remain active");
    }
    return this.get(id);
  }

  async archive(id: string, actorId: string): Promise<void> {
    try {
      await this.accounts.archive(id, actorId, this.dependencies.now());
    } catch (cause) {
      mapDefaultAccountConstraint(cause, "A default account cannot be archived");
    }
  }

  async verify(id: string, actorId: string): Promise<ModelProviderAccount> {
    const account = await this.getAccountForOperation(id, "active_use");
    const adapter = this.requireAdapter(account.provider);
    const current = await this.credentials.readCredentialState(account.id, account.provider);
    if (!current) throw new ProviderAccountServiceError("Provider credential not found", 409);
    if (current.exchangeState !== "idle") {
      throw new ProviderAccountServiceError(
        "Provider credential verification is already in progress",
        409
      );
    }
    const owner = this.dependencies.generateId();
    const now = this.dependencies.now();
    try {
      const result = await this.exchange.run({
        providerAccountId: account.id,
        provider: account.provider,
        state: current,
        expectedAccountStatus: "active",
        adapter,
        owner,
        now: this.dependencies.now,
        complete: ({ write, refreshed }) => {
          this.validateExternalIdentity(
            adapter,
            refreshed.externalAccountId,
            account.externalAccountId
          );
          return this.atomicWriter.completeVerificationCredentialAndAccount({
            ...write,
            externalAccountId: refreshed.externalAccountId ?? account.externalAccountId,
            status: "active",
            actorId,
            lastVerifiedAt: now,
          });
        },
      });
      if (result.kind === "claim_unavailable") {
        throw new ProviderAccountServiceError(
          "Provider credential verification is already in progress",
          409
        );
      }
    } catch (cause) {
      if (!(cause instanceof ClaimedProviderCredentialExchangeError)) throw cause;
      if (cause.terminalFence === "lost") {
        return this.reconcileVerificationFenceLoss(account, current);
      }
      if (cause.phase === "parse") {
        throw new ProviderAccountServiceError("Stored provider credential is invalid", 409, {
          cause: cause.cause,
        });
      }
      if (cause.phase === "refresh") {
        if (
          cause.cause instanceof ProviderRefreshError &&
          cause.cause.classification === "retry_safe"
        ) {
          throw new ProviderAccountServiceError(
            "Provider credential verification failed safely; retry the operation",
            502,
            { cause: cause.cause }
          );
        }
        throw new ProviderAccountServiceError("Provider account requires reconnection", 409, {
          cause: cause.cause,
        });
      }
      if (cause.cause instanceof ProviderAccountServiceError) throw cause.cause;
      throw this.consumedCredentialError(cause);
    }
    return this.get(id);
  }

  async reconnect(
    id: string,
    input: ReconnectModelProviderAccountRequest,
    actorId: string
  ): Promise<ModelProviderAccount> {
    const account = await this.getAccountForOperation(id, "reconnect");
    if (account.provider !== input.provider) {
      throw new ProviderAccountServiceError("Provider account does not match provider", 400);
    }
    const adapter = this.requireAdapter(account.provider);
    const parsedInput = adapter.parseConnectInput(input);
    this.validateReconnectInputIdentity(adapter, parsedInput, account.externalAccountId);
    const connected = await this.connectParsed(adapter, parsedInput);
    this.validateExternalIdentity(adapter, connected.externalAccountId, account.externalAccountId);
    return this.persistConnectedCredential(
      account,
      connected,
      adapter,
      actorId,
      this.dependencies.now()
    );
  }

  private async getAccountForOperation(
    id: string,
    operation: ProviderAccountOperation
  ): Promise<ModelProviderAccount> {
    const account = await this.get(id);
    if (providerAccountIneligibility(account, operation)) {
      throw new ProviderAccountServiceError("Provider account is not active", 409);
    }
    return account;
  }

  private async persistConnectedCredential(
    account: ModelProviderAccount,
    connected: ProviderConnectionResult<unknown>,
    adapter: ErasedProviderAccountAdapter,
    actorId: string,
    now: number
  ): Promise<ModelProviderAccount> {
    const current = await this.credentials.readCredentialState(account.id, account.provider);
    if (!current) throw this.consumedCredentialError();
    try {
      const replaced = await this.atomicWriter.reconnectCredentialAndAccount({
        providerAccountId: account.id,
        provider: account.provider,
        credentialSchemaVersion: adapter.credentialSchemaVersion,
        expectedCredentialVersion: current.credentialVersion,
        payload: connected.credential,
        accessTokenExpiresAt: connected.accessTokenExpiresAt,
        externalAccountId: connected.externalAccountId ?? account.externalAccountId,
        status: "active",
        actorId,
        lastVerifiedAt: now,
        now,
      });
      if (!replaced) throw new Error("Provider credential changed concurrently");
    } catch (cause) {
      throw this.consumedCredentialError(cause);
    }
    return this.get(account.id);
  }

  private async reconcileVerificationFenceLoss(
    previousAccount: ModelProviderAccount,
    previousState: ProviderCredentialState
  ): Promise<ModelProviderAccount> {
    const account = await this.get(previousAccount.id);
    const ineligibility = providerAccountIneligibility(account, "active_use");
    if (ineligibility === "reconnect_required") {
      throw new ProviderAccountServiceError("Provider account requires reconnection", 409);
    }
    if (ineligibility) {
      throw new ProviderAccountServiceError("Provider account is not active", 409);
    }
    const state = await this.credentials.readCredentialState(account.id, account.provider);
    if (!state) throw new ProviderAccountServiceError("Provider credential not found", 409);
    if (state.credentialVersion !== previousState.credentialVersion) return account;
    throw new ProviderAccountServiceError(
      "Provider credential verification lost its durable claim",
      409
    );
  }

  private consumedCredentialError(cause?: unknown): ProviderAccountServiceError {
    return new ProviderAccountServiceError(
      "The submitted credential may have been consumed and could not be saved safely. Obtain a fresh credential and reconnect.",
      409,
      cause === undefined ? undefined : { cause }
    );
  }

  private requireAdapter(provider: ModelProviderId) {
    const adapter = this.adapters.get(provider);
    if (!adapter) throw new ProviderAccountServiceError(`${provider} is unavailable`, 409);
    return adapter;
  }

  private async connect(
    adapter: ErasedProviderAccountAdapter,
    input: ConnectModelProviderAccountRequest | ReconnectModelProviderAccountRequest
  ): Promise<ProviderConnectionResult<unknown>> {
    return this.connectParsed(adapter, adapter.parseConnectInput(input));
  }

  private async connectParsed(
    adapter: ErasedProviderAccountAdapter,
    input: unknown
  ): Promise<ProviderConnectionResult<unknown>> {
    try {
      return await adapter.connect(input);
    } catch (cause) {
      if (cause instanceof ProviderIdentityError) {
        throw new ProviderAccountServiceError(cause.message, 409, { cause });
      }
      throw cause;
    }
  }

  private validateReconnectInputIdentity(
    adapter: ErasedProviderAccountAdapter,
    input: unknown,
    expectedExternalAccountId: string | null
  ): void {
    try {
      adapter.validateReconnectInputIdentity(input, expectedExternalAccountId);
    } catch (cause) {
      if (cause instanceof ProviderIdentityError) {
        throw new ProviderAccountServiceError(cause.message, 409, { cause });
      }
      throw cause;
    }
  }

  private validateExternalIdentity(
    adapter: ErasedProviderAccountAdapter,
    actual: string | undefined,
    expected: string | null
  ): void {
    try {
      adapter.validateExternalIdentity(actual, expected);
    } catch (cause) {
      if (cause instanceof ProviderIdentityError) {
        throw new ProviderAccountServiceError(cause.message, 409, { cause });
      }
      throw cause;
    }
  }
}
