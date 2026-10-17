const RETRY_INTERVAL_MS = 5_000;

/** A projection failure that is safe to retry after the job's bounded attempts. */
export class RetryablePiProjectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryablePiProjectionError";
  }
}

export function projectionRetryOutcome(
  error: unknown,
  now: () => number = Date.now
): { rescheduleAt: number } | undefined {
  return error instanceof RetryablePiProjectionError
    ? { rescheduleAt: now() + RETRY_INTERVAL_MS }
    : undefined;
}
