/** Thrown by the app-wide SWR fetcher so hooks can tell terminal HTTP failures from transient ones. */
export class SwrFetchError extends Error {
  constructor(readonly status: number) {
    super(`Fetch failed: ${status}`);
    this.name = "SwrFetchError";
  }
}
