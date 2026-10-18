const RETRY_INTERVAL_MS = 5_000;
const ADMISSION_GRACE_MS = 30_000;
const DELIVERY_RETRY_WINDOW_MS = 24 * 60 * 60 * 1_000;

/** A projection failure that is safe to retry after the job's bounded attempts. */
export class RetryablePiProjectionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RetryablePiProjectionError";
  }
}

/** SessionDO deterministically rejected a terminal result; retrying cannot change the outcome. */
export class PermanentPiResultDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermanentPiResultDeliveryError";
  }
}

export function projectionRetryOutcome(
  error: unknown,
  deliveryDeadline: number,
  now: () => number = Date.now
): { rescheduleAt: number } | undefined {
  return error instanceof RetryablePiProjectionError && now() < deliveryDeadline
    ? { rescheduleAt: now() + RETRY_INTERVAL_MS }
    : undefined;
}

export function projectionAdmissionDeadline(now: () => number = Date.now): number {
  return now() + ADMISSION_GRACE_MS;
}

export function projectionDeliveryDeadline(now: () => number = Date.now): number {
  return now() + DELIVERY_RETRY_WINDOW_MS;
}

export function shouldAwaitProjectionAdmission(
  result: { status: "done" | "unanswered"; reason?: string },
  admissionDeadline: number,
  now: () => number = Date.now
): boolean {
  return (
    result.status === "unanswered" && result.reason === "not_found" && now() < admissionDeadline
  );
}
