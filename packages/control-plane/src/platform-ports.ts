import type { FetchClient } from "@open-inspect/shared/service-auth";

export type { FetchClient } from "@open-inspect/shared/service-auth";

/** Capability consumed by application services that defer background work. */
export interface BackgroundTasks {
  submit(
    task: Promise<unknown>,
    metadata: { name: string; context?: Record<string, unknown> }
  ): void;
}

/** Access the runtime's single scheduled wake-up. */
export interface AlarmScheduler {
  schedule(at: number): Promise<void>;
  cancel(): Promise<void>;
  current(): Promise<number | null>;
}

// Keep platform compatibility checked at the boundary rather than widening every consumer.
type _AssertExtends<A extends B, B> = A;
type _FetcherSatisfiesFetchClient = _AssertExtends<Fetcher, FetchClient>;
