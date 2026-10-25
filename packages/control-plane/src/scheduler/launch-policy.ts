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
