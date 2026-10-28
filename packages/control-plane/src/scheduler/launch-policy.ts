import type { SandboxSettings } from "@open-inspect/shared/types/integrations";
import { MAX_IMAGE_BUILD_PROVIDER_SESSION_TIMEOUT_MS } from "../image-builds/timeouts";
import { resolveExecutionBudgetMs } from "../sandbox/execution-budget";
import type { Env } from "../types";

/**
 * Wait before a scheduled run's first relaunch after its launch failed, doubling for each
 * later attempt. Long enough for a transient outage, such as a stalled D1, to clear.
 */
const LAUNCH_RETRY_BASE_DELAY_MS = 2 * 60 * 1000;

/** How long a run waits to relaunch after its `attempt`-th launch failed. */
export function launchRetryDelayMs(attempt: number): number {
  return LAUNCH_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
}

/**
 * Launch work the deadline must still cover once the longest image build has
 * finished: sandbox spawn, prompt enqueue, and the slack in the session
 * watchdog's own alarm scheduling.
 */
const EXECUTION_DEADLINE_LAUNCH_ALLOWANCE_MS = 30 * 60 * 1000;

/**
 * Head start the session's own execution watchdog gets over the recovery
 * sweep. A run's clock starts at claim; the watchdog's starts when the message
 * begins processing, after any repository image build and the sandbox spawn.
 * The grace is derived from the build provider-session bound rather than
 * chosen, so a build that spends its entire budget still cannot let the sweep
 * fire before the session fails its own message and the callback carries the
 * real reason. The sweep exists to catch a lost callback, and reaping a live
 * run is far worse than reaping a dead one late.
 */
export const EXECUTION_DEADLINE_GRACE_MS =
  MAX_IMAGE_BUILD_PROVIDER_SESSION_TIMEOUT_MS + EXECUTION_DEADLINE_LAUNCH_ALLOWANCE_MS;

/**
 * Settings a session is created with when neither its repository nor its
 * environment overrides the sandbox defaults; the budget then comes from the
 * deployment configuration alone.
 */
export const DEPLOYMENT_DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {};

/** Duration from session claim until the recovery sweep may declare the run lost. */
export function executionDeadlineMs(sandboxSettings: SandboxSettings, env: Env): number {
  return resolveExecutionBudgetMs(sandboxSettings, env) + EXECUTION_DEADLINE_GRACE_MS;
}

/**
 * Per-tick cap on child-run launches. Each launch costs ~8 subrequests, so an
 * uncapped 25-automation × 10-repo tick would blow the Workers per-invocation
 * subrequest limit; automations left overdue when the budget runs out are
 * simply picked up next tick.
 */
export const TICK_CHILD_LAUNCH_BUDGET = 50;

/**
 * Smooths Modal cold-start pressure for multi-repo fan-out. The maximum fan-out
 * is 10 repositories, so this only caps the per-invocation spike.
 */
export const AUTOMATION_LAUNCH_CONCURRENCY = 4;

/** Most relaunches per tick; half the child-launch budget, so due firings still start. */
export const MAX_RELAUNCHES_PER_TICK = Math.floor(TICK_CHILD_LAUNCH_BUDGET / 2);

/** Run `task` over `items`, at most `concurrency` at a time. */
export async function forEachConcurrently<T>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const item = items[next++];
        if (item === undefined) return;
        await task(item);
      }
    })
  );
}
