const CALLBACK_ATTEMPTS = 2;
const CALLBACK_RETRY_DELAY_MS = 1000;
const CALLBACK_ATTEMPT_TIMEOUT_MS = 10_000;

type DeliveryFailure =
  | { attempt: number; response: Response; error?: never }
  | { attempt: number; response?: never; error: unknown };

export async function deliverWithRetry(
  send: (signal: AbortSignal) => Promise<Response>,
  sleep: (ms: number) => Promise<void>,
  onFailure: (failure: DeliveryFailure) => void | Promise<void>
): Promise<boolean> {
  for (let attempt = 1; attempt <= CALLBACK_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CALLBACK_ATTEMPT_TIMEOUT_MS);
    let failure: DeliveryFailure;
    try {
      const response = await send(controller.signal);
      if (response.ok) return true;
      failure = { attempt, response };
    } catch (error) {
      failure = { attempt, error };
    } finally {
      clearTimeout(timeout);
    }
    try {
      await onFailure(failure);
    } catch {
      // Observability must not alter the delivery retry policy.
    }

    if (attempt < CALLBACK_ATTEMPTS) await sleep(CALLBACK_RETRY_DELAY_MS);
  }
  return false;
}
