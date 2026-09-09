import {
  PROVIDER_AUTHORIZATION_LIVE_STATES,
  PROVIDER_AUTHORIZATION_TERMINAL_STATES,
  type ProviderAccountAuthorizationStore,
  type ProviderAuthorization,
  type ProviderAuthorizationLive,
  type ProviderAuthorizationLiveState,
  type ProviderAuthorizationTerminalState,
} from "../db/provider-account-authorizations";
import type { ModelProviderId } from "./provider-auth-contracts";

/** A transaction the user has not completed within this window expires locally. */
export const PROVIDER_AUTHORIZATION_TRANSACTION_LIFETIME_MS = 10 * 60 * 1000;
/** A processing claim older than this belongs to a dead worker and fails closed. */
export const PROVIDER_AUTHORIZATION_PROCESSING_CLAIM_TIMEOUT_MS = 30 * 1000;

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

/**
 * The caller's own transaction. A transaction under another provider is
 * reported as missing so the ID space reveals nothing across providers.
 */
export async function ownedAuthorization(
  transactions: Pick<ProviderAccountAuthorizationStore, "getOwned">,
  userId: string,
  provider: ModelProviderId,
  id: string
): Promise<ProviderAuthorization> {
  const row = await transactions.getOwned(userId, id);
  if (!row || row.provider !== provider) {
    throw new ProviderAuthorizationError("Authorization transaction not found", 404);
  }
  return row;
}

/** The owned row after any lapsed lifetime has been durably recorded as expiry. */
export async function resolveDurableAuthorization(
  transactions: Pick<ProviderAccountAuthorizationStore, "getOwned" | "expire">,
  userId: string,
  provider: ModelProviderId,
  id: string,
  now: number
): Promise<ProviderAuthorization> {
  while (true) {
    const current = await ownedAuthorization(transactions, userId, provider, id);
    if (!isLiveAuthorization(current) || current.expiresAt > now) return current;
    await transactions.expire(current, now);
  }
}
