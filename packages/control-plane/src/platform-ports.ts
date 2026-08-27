import type { FetchClient } from "@open-inspect/shared/service-auth";

export type { FetchClient } from "@open-inspect/shared/service-auth";

/** Capability consumed by application services that defer background work. */
export interface BackgroundTasks {
  /**
   * Start `task` and let it run past the current request. The factory is
   * invoked synchronously inside `submit`, and a synchronous throw is absorbed
   * and logged exactly like a rejection — building the task can never fail the
   * caller.
   */
  submit(
    task: () => Promise<unknown>,
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
