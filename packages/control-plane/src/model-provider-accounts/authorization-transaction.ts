import type { ModelProviderAccountStatus } from "@open-inspect/shared/types/provider-accounts";
import {
  PROVIDER_AUTHORIZATION_LIVE_STATES,
  PROVIDER_AUTHORIZATION_TERMINAL_STATES,
  type ProcessingProviderAuthorization,
  type ProviderAccountAuthorizationStore,
  type ProviderAuthorization,
  type ProviderAuthorizationKind,
  type ProviderAuthorizationLive,
  type ProviderAuthorizationLiveState,
  type ProviderAuthorizationTerminalState,
} from "../db/provider-account-authorizations";
import type { ModelProviderAccountStore } from "../db/model-provider-accounts";
import type { ModelProviderId } from "./provider-auth-contracts";

/** A transaction the user has not completed within this window expires locally. */
export const PROVIDER_AUTHORIZATION_TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;
/**
 * A processing claim older than this belongs to a dead worker and fails
 * closed. It must comfortably exceed the longest provider call a claim
 * holder makes plus finalization, or a status request can fail a healthy
 * exchange while the provider is still answering it (the Anthropic token
 * exchange allows 30s; device polls allow 10s).
 */
export const PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS = 90 * 1000;

export class ProviderAuthorizationError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable = false
  ) {
    super(message);
  }
}

export interface TerminalProviderAuthorizationStatus {
  status: ProviderAuthorizationTerminalState;
  error: string;
  retryable: boolean;
}

const TERMINAL_MESSAGES: Record<ProviderAuthorizationTerminalState, string> = {
  denied: "Provider authorization was denied.",
  expired: "Provider authorization expired.",
  failed: "Provider authorization failed. Start a fresh authorization.",
  cancelled: "Provider authorization was cancelled.",
  superseded: "A newer authorization attempt replaced this one.",
};

export function terminalAuthorizationStatus(
  state: ProviderAuthorizationTerminalState,
  error: string = TERMINAL_MESSAGES[state]
): TerminalProviderAuthorizationStatus {
  return { status: state, error, retryable: state !== "denied" };
}

export function isTerminalAuthorization(
  row: ProviderAuthorization
): row is Extract<ProviderAuthorization, { state: ProviderAuthorizationTerminalState }> {
  return PROVIDER_AUTHORIZATION_TERMINAL_STATES.includes(
    row.state as ProviderAuthorizationTerminalState
  );
}

export function isLiveAuthorization(row: ProviderAuthorization): row is ProviderAuthorizationLive {
  return PROVIDER_AUTHORIZATION_LIVE_STATES.includes(row.state as ProviderAuthorizationLiveState);
}

export function isClaimStale(row: ProcessingProviderAuthorization, now: number): boolean {
  return row.processingStartedAt + PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS <= now;
}

/**
 * The caller's own transaction of the expected kind. A transaction under
 * another provider or completion kind is reported as missing, so the ID space
 * reveals nothing across providers and neither route family can read, claim,
 * or settle the other's rows. The kind never changes after reservation, so a
 * row that passes here stays the right kind for every write keyed on its id.
 */
export async function ownedAuthorization(
  transactions: Pick<ProviderAccountAuthorizationStore, "getOwned">,
  userId: string,
  provider: ModelProviderId,
  kind: ProviderAuthorizationKind,
  id: string
): Promise<ProviderAuthorization> {
  const row = await transactions.getOwned(userId, id);
  if (!row || row.provider !== provider || row.authorizationKind !== kind) {
    throw new ProviderAuthorizationError("Authorization transaction not found", 404);
  }
  return row;
}

/** The owned row after any lapsed lifetime has been durably recorded as expiry. */
export async function resolveDurableAuthorization(
  transactions: Pick<ProviderAccountAuthorizationStore, "getOwned" | "expire">,
  userId: string,
  provider: ModelProviderId,
  kind: ProviderAuthorizationKind,
  id: string,
  now: number
): Promise<ProviderAuthorization> {
  while (true) {
    const current = await ownedAuthorization(transactions, userId, provider, kind, id);
    if (!isLiveAuthorization(current) || current.expiresAt > now) return current;
    await transactions.expire(current, now);
  }
}

/** A live transaction is cancelled; settled ones are left as they are. */
export async function cancelAuthorization(
  transactions: Pick<ProviderAccountAuthorizationStore, "getOwned" | "finish">,
  userId: string,
  provider: ModelProviderId,
  kind: ProviderAuthorizationKind,
  id: string,
  now: number
): Promise<void> {
  const row = await ownedAuthorization(transactions, userId, provider, kind, id);
  if (!isTerminalAuthorization(row) && row.state !== "connected") {
    await transactions.finish(id, userId, "cancelled", now);
  }
}

export type ReserveAuthorizationInput =
  | { operation: "create"; displayName: string }
  | { operation: "reconnect"; providerAccountId: string };

export interface ReservedAuthorization {
  id: string;
  expiresAt: number;
  now: number;
}

/**
 * The part of starting a transaction that precedes the provider: validate a
 * reconnect target, spend an attempt, and reserve the row in `initiating`.
 * Both completion kinds share it verbatim.
 */
export async function reserveAuthorization(
  transactions: Pick<ProviderAccountAuthorizationStore, "recordAttempt" | "reserve">,
  accounts: Pick<ModelProviderAccountStore, "getLifecycleSnapshot">,
  dependencies: { generateId: (bytes: number) => string; now: () => number },
  userId: string,
  provider: ModelProviderId,
  kind: ProviderAuthorizationKind,
  input: ReserveAuthorizationInput
): Promise<ReservedAuthorization> {
  let targetAccountStatus: ModelProviderAccountStatus | null = null;
  let targetAccountLifecycleVersion: number | null = null;
  if (input.operation === "reconnect") {
    const snapshot = await accounts.getLifecycleSnapshot(input.providerAccountId);
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

  const now = dependencies.now();
  const id = dependencies.generateId(32);
  const attemptId = dependencies.generateId(32);
  if (!(await transactions.recordAttempt(attemptId, userId, now))) {
    throw new ProviderAuthorizationError(
      "Too many authorization attempts; try again shortly",
      429,
      true
    );
  }
  const expiresAt = now + PROVIDER_AUTHORIZATION_TRANSACTION_LIFETIME_MS;
  const reserved = await transactions.reserve({
    id,
    userId,
    provider,
    authorizationKind: kind,
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
  return { id, expiresAt, now };
}

export interface ConnectedAuthorizationStatus {
  status: "connected";
  account: NonNullable<Awaited<ReturnType<ModelProviderAccountStore["getById"]>>>;
  reconnectedExisting: boolean;
  completedAt: number;
}

/** The connected outcome both completion kinds report. */
export async function connectedAuthorizationStatus(
  accounts: Pick<ModelProviderAccountStore, "getById">,
  row: Extract<ProviderAuthorization, { state: "connected" }>
): Promise<ConnectedAuthorizationStatus> {
  const account = await accounts.getById(row.resultProviderAccountId);
  if (!account) throw new ProviderAuthorizationError("Connected account not found", 409);
  return {
    status: "connected",
    account,
    reconnectedExisting: row.reconnectedExisting,
    completedAt: row.completedAt,
  };
}
