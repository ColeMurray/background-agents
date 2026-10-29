const PROVIDER_STOP_TIMEOUT_MS = 10_000;

export type ProviderStopOutcome = "confirmed" | "not_stopped";

/** Bounds local waiting, not remote cancellation; callers own retirement policy. */
export async function boundedProviderStop(
  stop: (signal: AbortSignal) => Promise<ProviderStopOutcome>,
  timeoutMessage: string
): Promise<ProviderStopOutcome> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  try {
    const stopTimeoutPromise = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(() => {
        controller.abort();
        reject(new Error(timeoutMessage));
      }, PROVIDER_STOP_TIMEOUT_MS);
    });
    return await Promise.race([stop(controller.signal), stopTimeoutPromise]);
  } finally {
    if (timeoutId !== undefined) clearTimeout(timeoutId);
  }
}
