import type { FetchClient } from "@open-inspect/shared/service-auth";

export type { FetchClient } from "@open-inspect/shared/service-auth";

/** Capability consumed by application services that schedule background work. */
export interface BackgroundTaskContext {
  waitUntil(promise: Promise<unknown>): void;
}

// Keep platform compatibility checked at the boundary rather than widening every consumer.
type _AssertExtends<A extends B, B> = A;
type _FetcherSatisfiesFetchClient = _AssertExtends<Fetcher, FetchClient>;
type _ExecutionContextSatisfiesBackgroundTaskContext = _AssertExtends<
  ExecutionContext,
  BackgroundTaskContext
>;
