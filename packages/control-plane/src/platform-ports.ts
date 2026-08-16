/** Capabilities consumed from a service binding that only performs HTTP requests. */
export interface FetchClient {
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/** Capability consumed by application services that schedule background work. */
export interface BackgroundTaskContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Background-task context with the Durable Object identity used as a fallback session ID. */
export interface DurableObjectTaskContext extends BackgroundTaskContext {
  id: { toString(): string };
}

// Keep platform compatibility checked at the boundary rather than widening every consumer.
type _AssertExtends<A extends B, B> = A;
type _FetcherSatisfiesFetchClient = _AssertExtends<Fetcher, FetchClient>;
type _ExecutionContextSatisfiesBackgroundTaskContext = _AssertExtends<
  ExecutionContext,
  BackgroundTaskContext
>;
type _DurableObjectStateSatisfiesTaskContext = _AssertExtends<
  DurableObjectState,
  DurableObjectTaskContext
>;
