export class RequestDeadlineError extends Error {
  constructor(
    public readonly provider: string,
    public readonly endpoint: string,
    public readonly timeoutMs: number,
    cause?: unknown
  ) {
    super(`${provider} request timeout after ${timeoutMs}ms (${endpoint})`, { cause });
    this.name = "RequestDeadlineError";
  }
}

export async function withRequestDeadline<T>(
  provider: string,
  endpoint: string,
  timeoutMs: number,
  callerSignal: AbortSignal | null | undefined,
  operation: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const deadlineReason = new DOMException("Request deadline exceeded", "TimeoutError");
  const timeoutId = setTimeout(() => controller.abort(deadlineReason), timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, controller.signal])
    : controller.signal;

  try {
    return await operation(signal);
  } catch (error) {
    if (signal.reason === deadlineReason) {
      throw new RequestDeadlineError(provider, endpoint, timeoutMs, error);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
