import type { FetchClient } from "@open-inspect/shared/service-auth";

export type { FetchClient } from "@open-inspect/shared/service-auth";

/** Capability consumed by application services that schedule background work. */
export interface BackgroundJobDispatcher {
  submit(job: Promise<unknown>): void;
}

/** Schedule the runtime's wake-up no later than the given timestamp. */
export interface AlarmScheduler {
  scheduleAlarm(timestamp: number): Promise<void>;
}

// Keep platform compatibility checked at the boundary rather than widening every consumer.
type _AssertExtends<A extends B, B> = A;
type _FetcherSatisfiesFetchClient = _AssertExtends<Fetcher, FetchClient>;
