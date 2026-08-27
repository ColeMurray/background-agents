const CALLBACK_ATTEMPTS = 2;
const CALLBACK_RETRY_DELAY_MS = 1000;
const CALLBACK_ATTEMPT_TIMEOUT_MS = 10_000;

export type RetryAttemptResult<TValue, TFailure> =
  | { outcome: "delivered"; value: TValue }
  | { outcome: "retryable_failure"; failure: TFailure };

type RetryFailure<TFailure> =
  | { attempt: number; failure: TFailure; error?: never }
  | { attempt: number; failure?: never; error: unknown };

type RetryResult<TValue, TFailure> =
  | { outcome: "delivered"; attempts: number; value: TValue }
  | { outcome: "failed"; attempts: number; failure?: TFailure };

export async function retryDelivery<TValue, TFailure>(
  send: (signal: AbortSignal) => Promise<RetryAttemptResult<TValue, TFailure>>,
  sleep: (ms: number) => Promise<void>,
  onFailure: (failure: RetryFailure<TFailure>) => void | Promise<void>,
  options: { attemptTimeoutMs?: number | null } = {}
): Promise<RetryResult<TValue, TFailure>> {
  const attemptTimeoutMs =
    options.attemptTimeoutMs === undefined ? CALLBACK_ATTEMPT_TIMEOUT_MS : options.attemptTimeoutMs;
  let finalFailure: TFailure | undefined;
  for (let attempt = 1; attempt <= CALLBACK_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout =
      attemptTimeoutMs === null
        ? undefined
        : setTimeout(() => controller.abort(), attemptTimeoutMs);
    let failure: RetryFailure<TFailure>;
    finalFailure = undefined;
    try {
      const result = await send(controller.signal);
      if (result.outcome === "delivered") {
        return { outcome: "delivered", attempts: attempt, value: result.value };
      }
      finalFailure = result.failure;
      failure = { attempt, failure: result.failure };
    } catch (error) {
      failure = { attempt, error };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
    try {
      await onFailure(failure);
    } catch {
      // Observability must not alter the delivery retry policy.
    }

    if (attempt < CALLBACK_ATTEMPTS) await sleep(CALLBACK_RETRY_DELAY_MS);
  }
  return {
    outcome: "failed",
    attempts: CALLBACK_ATTEMPTS,
    ...(finalFailure !== undefined ? { failure: finalFailure } : {}),
  };
}

type DeliveryFailure =
  | { attempt: number; response: Response; error?: never }
  | { attempt: number; response?: never; error: unknown };

interface DeliveryResult {
  delivered: boolean;
  attempts: number;
  httpStatus?: number;
}

export async function deliverWithRetry(
  send: (signal: AbortSignal) => Promise<Response>,
  sleep: (ms: number) => Promise<void>,
  onFailure: (failure: DeliveryFailure) => void | Promise<void>,
  options: { attemptTimeoutMs?: number | null } = {}
): Promise<DeliveryResult> {
  const result = await retryDelivery(
    async (signal) => {
      const response = await send(signal);
      return response.ok
        ? { outcome: "delivered", value: response }
        : { outcome: "retryable_failure", failure: response };
    },
    sleep,
    ({ attempt, failure, error }) =>
      onFailure(failure ? { attempt, response: failure } : { attempt, error }),
    options
  );

  if (result.outcome === "delivered") {
    return { delivered: true, attempts: result.attempts, httpStatus: result.value.status };
  }
  return {
    delivered: false,
    attempts: result.attempts,
    ...(result.failure ? { httpStatus: result.failure.status } : {}),
  };
}
