const CALLBACK_ATTEMPTS = 2;
const CALLBACK_RETRY_DELAY_MS = 1000;

type DeliveryFailure =
  | { attempt: number; response: Response; error?: never }
  | { attempt: number; response?: never; error: unknown };

export async function deliverWithRetry(
  send: () => Promise<Response>,
  sleep: (ms: number) => Promise<void>,
  onFailure: (failure: DeliveryFailure) => void | Promise<void>
): Promise<boolean> {
  for (let attempt = 1; attempt <= CALLBACK_ATTEMPTS; attempt++) {
    let failure: DeliveryFailure;
    try {
      const response = await send();
      if (response.ok) return true;
      failure = { attempt, response };
    } catch (error) {
      failure = { attempt, error };
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
