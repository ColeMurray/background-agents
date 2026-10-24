/**
 * The budget gate: the cost limit is checked *before* every model call.
 *
 * A sandbox harness spends money inside a box the platform can stop. A
 * Durable Object harness has no such box, so the check has to happen on the
 * harness's own path — and the only place every model call passes through is
 * the provider's `stream` and `streamSimple`.
 *
 * So the provider is wrapped. The wrapper asks the owning session what the
 * budget is *now*, and refuses the call when the limit is already reached. The
 * cost of the call that crosses the limit is then stopped by the session's own
 * stop, which the reference model calls the synchronous in-harness stop.
 *
 * The contract is harness-neutral: it names a budget, not a model, and it
 * works for any provider that streams.
 */

/** The budget, as it stands now. */
export interface HarnessBudgetState {
  /** Whether the limit has already been reached. */
  readonly exhausted: boolean;
  /** What the turn has spent. */
  readonly spentUsd: number;
  /** The limit, or null when the turn is unlimited. */
  readonly capUsd: number | null;
}

/** Reads the budget, now. */
export type HarnessBudgetReader = () => Promise<HarnessBudgetState>;

/**
 * The part of a provider the gate touches.
 *
 * The provider's *methods* are what a model runtime calls, so the gate wraps
 * those: wrapping the provider's api instead would leave every call outside
 * the gate. The seam does not know a model SDK's types, so it reads the two
 * methods structurally.
 */
export interface HarnessGateProvider {
  stream?: (...args: never[]) => unknown;
  streamSimple?: (...args: never[]) => unknown;
  [key: string]: unknown;
}

/**
 * Wrap a provider so every model call is gated by the budget.
 *
 * The wrapper is deliberately thin: it adds a check and nothing else, so the
 * provider's own behaviour — retries, streaming, deferred fetches — is
 * untouched.
 */
export function createBudgetGateProvider<Gate extends object>(
  provider: Gate,
  read: HarnessBudgetReader
): Gate {
  const target = provider as HarnessGateProvider;
  const guard = async (): Promise<void> => {
    const state = await read();
    if (state.exhausted) {
      throw new Error("The session's cost limit has been reached");
    }
  };
  const originalStream = target.stream;
  const originalStreamSimple = target.streamSimple;
  return {
    ...provider,
    stream: async (...args: never[]) => {
      await guard();
      return originalStream?.(...args);
    },
    streamSimple: async (...args: never[]) => {
      await guard();
      return originalStreamSimple?.(...args);
    },
  } as Gate;
}
