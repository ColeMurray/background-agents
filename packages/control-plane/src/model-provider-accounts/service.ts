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
  ProviderCredentialExchangeAccountStatus,
  ProviderCredentialState,
  ProviderCredentialStore,
} from "../db/provider-account-credentials";
import type { ModelProviderAccountAtomicWriter } from "../db/model-provider-account-atomic-writer";
import type { ModelProviderId } from "./provider-auth-contracts";
import {
  type ModelProviderAccountAdapter,
  type ModelProviderAccountAdapterRegistry,
  type ProviderConnectionResult,
} from "../auth/model-provider-account-adapters";
import {
  ClaimedProviderCredentialExchange,
  ClaimedProviderCredentialExchangeError,
} from "../auth/claimed-provider-credential-exchange";

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
  ): Promise<{ account: ModelProviderAccount; reconnectedExisting: boolean }> {
    const adapter = this.requireAdapter(input.provider);
    const preflight =
      input.provider === "openai"
        ? await this.accounts.findByExternalIdentity(input.provider, input.accountId)
        : null;
    const connected = await adapter.connect(adapter.parseConnectInput(input));
    if (input.provider === "openai") {
      this.requireTrustedOpenAIIdentity(
        input.provider,
        connected.externalAccountId,
        input.accountId
      );
    }
    const now = this.dependencies.now();
    const externalAccountId = connected.externalAccountId ?? null;
    let existing = preflight;
    if (!existing && externalAccountId) {
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
      return {
        account: await this.atomicWriter.createAccountWithCredential({
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
        }),
        reconnectedExisting: false,
      };
    } catch (cause) {
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
      throw new ProviderAccountServiceError("A default account must remain active", 409);
    }
    return this.get(id);
  }

  async archive(id: string, actorId: string): Promise<void> {
    try {
      await this.accounts.archive(id, actorId, this.dependencies.now());
    } catch {
      throw new ProviderAccountServiceError("A default account cannot be archived", 409);
    }
  }

  async verify(id: string, actorId: string): Promise<ModelProviderAccount> {
    const account = await this.getUsableAccount(id);
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
        expectedAccountStatus: account.status,
        adapter,
        owner,
        now: this.dependencies.now,
        complete: ({ write, refreshed }) => {
          this.requireTrustedOpenAIIdentity(
            account.provider,
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
      if (cause.phase !== "completion") throw cause.cause;
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
    const account = await this.get(id);
    if (account.provider !== input.provider) {
      throw new ProviderAccountServiceError("Provider account does not match provider", 400);
    }
    const adapter = this.requireAdapter(account.provider);
    const connected = await adapter.connect(adapter.parseConnectInput(input));
    if (input.provider === "openai") {
      this.requireTrustedOpenAIIdentity(
        input.provider,
        connected.externalAccountId,
        input.accountId
      );
      this.requireTrustedOpenAIIdentity(
        input.provider,
        connected.externalAccountId,
        account.externalAccountId
      );
    } else if (
      account.externalAccountId &&
      connected.externalAccountId &&
      connected.externalAccountId !== account.externalAccountId
    ) {
      throw new ProviderAccountServiceError("Provider account identity did not match", 409);
    }
    return this.persistConnectedCredential(
      account,
      connected,
      adapter,
      actorId,
      this.dependencies.now()
    );
  }

  private async getUsableAccount(
    id: string
  ): Promise<ModelProviderAccount & { status: ProviderCredentialExchangeAccountStatus }> {
    const account = await this.get(id);
    if (account.archivedAt !== null) {
      throw new ProviderAccountServiceError("Provider account is not active", 409);
    }
    if (account.status === "disabled") {
      throw new ProviderAccountServiceError("Provider account is not active", 409);
    }
    return { ...account, status: account.status };
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

  private requireTrustedOpenAIIdentity(
    provider: ModelProviderId,
    actual: string | undefined,
    expected: string | null
  ): void {
    if (provider !== "openai") return;
    if (!actual) {
      throw new ProviderAccountServiceError("OpenAI account identity could not be verified", 409);
    }
    if (!expected || actual !== expected) {
      throw new ProviderAccountServiceError("OpenAI account identity did not match", 409);
    }
  }
}
