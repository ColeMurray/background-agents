/** Thrown by the app-wide SWR fetcher so hooks can tell terminal HTTP failures from transient ones. */
export class SwrFetchError extends Error {
  constructor(readonly status: number) {
    super(`Fetch failed: ${status}`);
    this.name = "SwrFetchError";
  }
}

/**
 * Deleted or inaccessible resources must not render from cache; only transient failures
 * (network, 5xx) keep the last loaded data.
 */
export function isTerminalFetchError(error: unknown): boolean {
  return error instanceof SwrFetchError && [401, 403, 404].includes(error.status);
}
