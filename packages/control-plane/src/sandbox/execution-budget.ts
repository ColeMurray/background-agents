import type { SandboxSettings } from "@open-inspect/shared/types/integrations";

import { DEFAULT_SANDBOX_TIMEOUT_SECONDS } from "./provider";
import type { Env } from "../types";

/**
 * How long a session may spend processing one message before the control plane
 * declares it stuck.
 *
 * `sandboxTimeoutMs` is also the sandbox's provider TTL, so a session cannot
 * outlive it; when it is unset the deployment-wide `EXECUTION_TIMEOUT_MS`
 * applies, and failing that the default sandbox lifetime.
 *
 * Both the session's own watchdog and the scheduler's lost-run sweep read the
 * budget through here. They resolve it from different places — the session
 * from its persisted settings snapshot, the scheduler from the settings it is
 * about to launch the session with — and a run whose backstop expires before
 * the session it is watching is exactly the failure this exists to prevent.
 */
export function resolveExecutionBudgetMs(sandboxSettings: SandboxSettings, env: Env): number {
  if (sandboxSettings.sandboxTimeoutMs !== undefined) return sandboxSettings.sandboxTimeoutMs;
  return (
    parseConfiguredExecutionTimeoutMs(env.EXECUTION_TIMEOUT_MS) ??
    DEFAULT_SANDBOX_TIMEOUT_SECONDS * 1000
  );
}

/**
 * `EXECUTION_TIMEOUT_MS` as a positive whole number of milliseconds, or
 * undefined when it is unset or malformed. The budget is persisted as every
 * automation run's sweep deadline, so a malformed value must fall through to
 * the default rather than become a NaN or instant deadline, and a value with
 * trailing garbage (`"1000ms"`) is rejected rather than partially honoured.
 */
function parseConfiguredExecutionTimeoutMs(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
