/** Thrown by the app-wide SWR fetcher so hooks can tell terminal HTTP failures from transient ones. */
export class SwrFetchError extends Error {
  constructor(readonly status: number) {
    super(`Fetch failed: ${status}`);
    this.name = "SwrFetchError";
  }
}

/**
 * Whether a failed fetch leaves the last loaded data usable. Failures without an HTTP response
 * (network errors, client-side response validation) say nothing about access, and an HTTP
 * timeout, rate limit, or 5xx may succeed on retry. Every other HTTP status, including any not
 * listed here, means the server no longer vouches for the data.
 */
export function isRetryableFetchError(error: unknown): boolean {
  if (!(error instanceof SwrFetchError)) return true;
  return error.status === 408 || error.status === 429 || error.status >= 500;
}

/** The last loaded data, or undefined once a non-retryable failure makes it unusable. */
export function usableFetchData<T>(data: T | undefined, error: unknown): T | undefined {
  return error && !isRetryableFetchError(error) ? undefined : data;
}
