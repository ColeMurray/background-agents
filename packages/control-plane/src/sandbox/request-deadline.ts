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
      throw new Error(`${provider} request timeout after ${timeoutMs}ms (${endpoint})`, {
        cause: error,
      });
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}
