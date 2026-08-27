import type {
  CompleteProviderExchangeInput,
  ProviderCredentialExchangeAccountStatus,
  ProviderCredentialState,
  ProviderCredentialStore,
} from "../db/provider-account-credentials";
import type { FenceProviderCredentialExchangeInput } from "../db/model-provider-account-atomic-writer";
import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import {
  ProviderRefreshError,
  type ModelProviderAccountAdapter,
  type ProviderRefreshResult,
} from "./model-provider-account-adapters";

type ErasedProviderAccountAdapter = ModelProviderAccountAdapter<unknown, unknown>;

export type ClaimedProviderCredentialExchangeStore = Pick<
  ProviderCredentialStore,
  "tryBeginExchange" | "clearSafeFailure"
>;

type ProviderCredentialTerminalFailure = (
  input: FenceProviderCredentialExchangeInput
) => Promise<boolean>;

interface CompletionContext {
  write: CompleteProviderExchangeInput & { now: number };
  refreshed: ProviderRefreshResult<unknown>;
}

export interface ClaimedProviderCredentialExchangeRequest {
  providerAccountId: string;
  provider: ModelProviderId;
  state: ProviderCredentialState;
  expectedAccountStatus: ProviderCredentialExchangeAccountStatus;
  adapter: ErasedProviderAccountAdapter;
  owner: string;
  now: () => number;
  complete: (context: CompletionContext) => Promise<boolean>;
}

export type ClaimedProviderCredentialExchangeResult =
  | { kind: "claim_unavailable" }
  | {
      kind: "completed";
      refreshed: ProviderRefreshResult<unknown>;
    };

export class ClaimedProviderCredentialExchangeError extends Error {
  constructor(
    readonly phase: "parse" | "refresh" | "completion",
    cause: unknown,
    readonly terminalFence: "not_attempted" | "committed" | "lost" = "not_attempted"
  ) {
    super(`Provider credential exchange failed during ${phase}`, { cause });
  }
}

export class ClaimedProviderCredentialExchange {
  constructor(
    private readonly store: ClaimedProviderCredentialExchangeStore,
    private readonly terminalFailure: ProviderCredentialTerminalFailure
  ) {}

  async run(
    request: ClaimedProviderCredentialExchangeRequest
  ): Promise<ClaimedProviderCredentialExchangeResult> {
    const claim = await this.store.tryBeginExchange(
      request.providerAccountId,
      request.state.credentialVersion,
      request.owner,
      request.expectedAccountStatus,
      request.now()
    );
    if (!claim.acquired) return { kind: "claim_unavailable" };

    let credential: unknown;
    try {
      credential = request.adapter.parseCredential(
        request.state.payload,
        request.state.credentialSchemaVersion
      );
    } catch (cause) {
      await this.clearAfterFailure(request, claim.generation);
      throw new ClaimedProviderCredentialExchangeError("parse", cause);
    }

    let refreshed: ProviderRefreshResult<unknown>;
    try {
      refreshed = await request.adapter.refresh(credential, request.now());
    } catch (cause) {
      if (cause instanceof ProviderRefreshError && cause.classification === "retry_safe") {
        await this.clearAfterFailure(request, claim.generation);
        throw new ClaimedProviderCredentialExchangeError("refresh", cause);
      }
      const fenced = await this.failTerminally(request, claim.generation);
      throw new ClaimedProviderCredentialExchangeError(
        "refresh",
        cause,
        fenced ? "committed" : "lost"
      );
    }

    const write: CompleteProviderExchangeInput & { now: number } = {
      providerAccountId: request.providerAccountId,
      provider: request.provider,
      credentialSchemaVersion: request.adapter.credentialSchemaVersion,
      payload: refreshed.credential,
      accessTokenExpiresAt: refreshed.accessTokenExpiresAt,
      expectedCredentialVersion: request.state.credentialVersion,
      exchangeGeneration: claim.generation,
      exchangeOwner: request.owner,
      expectedAccountStatus: request.expectedAccountStatus,
      now: request.now(),
    };
    try {
      const completed = await request.complete({ write, refreshed });
      if (!completed) {
        throw new ClaimedProviderCredentialExchangeError(
          "completion",
          new Error("Provider credential exchange lost its durable claim")
        );
      }
    } catch (cause) {
      const fenced = await this.failTerminally(request, claim.generation);
      const underlying =
        cause instanceof ClaimedProviderCredentialExchangeError ? cause.cause : cause;
      throw new ClaimedProviderCredentialExchangeError(
        "completion",
        underlying,
        fenced ? "committed" : "lost"
      );
    }

    return { kind: "completed", refreshed };
  }

  private clear(request: ClaimedProviderCredentialExchangeRequest, generation: number) {
    return this.store.clearSafeFailure(
      request.providerAccountId,
      request.state.credentialVersion,
      generation,
      request.owner,
      request.now()
    );
  }

  private async clearAfterFailure(
    request: ClaimedProviderCredentialExchangeRequest,
    generation: number
  ): Promise<void> {
    try {
      await this.clear(request, generation);
    } catch {
      // The original classified failure is authoritative. A failed clear leaves
      // the durable lease in flight until the stale-exchange path reconciles it.
    }
  }

  private async failTerminally(
    request: ClaimedProviderCredentialExchangeRequest,
    generation: number
  ): Promise<boolean> {
    try {
      return await this.terminalFailure({
        providerAccountId: request.providerAccountId,
        credentialVersion: request.state.credentialVersion,
        exchangeGeneration: generation,
        exchangeOwner: request.owner,
        now: request.now(),
      });
    } catch {
      // Preserve the original exchange failure and force the caller through
      // authoritative reconciliation when terminal fencing cannot be observed.
      return false;
    }
  }
}
