import { DEFAULT_SANDBOX_TIMEOUT_SECONDS } from "../sandbox/provider";

/** Preserve the bridge's existing turn allowance while making the CP its owner. */
export const MAX_EXECUTION_CLEANUP_RESERVE_MS = 900_000;
export const EXECUTION_CLEANUP_RESERVE_FRACTION = 0.25;

export function executionCleanupReserveMs(configuredDurationMs: number): number {
  return Math.min(
    MAX_EXECUTION_CLEANUP_RESERVE_MS,
    configuredDurationMs * EXECUTION_CLEANUP_RESERVE_FRACTION
  );
}

export function resolveExecutionPolicy(
  sandboxTimeoutMs: number | undefined,
  executionTimeoutOverride: string | undefined
) {
  const sandboxDurationMs = sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS * 1000;
  const bridgeAllowanceMs = sandboxDurationMs - executionCleanupReserveMs(sandboxDurationMs);
  const overrideMs = Number(executionTimeoutOverride);
  const hasOverride =
    sandboxTimeoutMs === undefined && Number.isFinite(overrideMs) && overrideMs > 0;
  return {
    sandboxDurationMs,
    turnAllowanceMs: hasOverride ? Math.min(overrideMs, bridgeAllowanceMs) : bridgeAllowanceMs,
    source:
      sandboxTimeoutMs !== undefined
        ? "session_sandbox_settings"
        : hasOverride
          ? "execution_timeout_env"
          : "default",
  };
}

export interface ExecutionBudget {
  executionDeadlineMs: number;
  cleanupDeadlineMs: number;
  cleanupReserveMs: number;
  sandboxId: string | null;
  requiresStopEvidence: boolean;
}

/** No provider lifetime is inferred when its adapter has no known bound. */
export function resolveExecutionBudget(
  now: number,
  configuredDurationMs: number,
  sandbox: {
    sandboxId: string | null;
    providerExpiresAtMs?: number | null;
    requiresStopEvidence: boolean;
    turnAllowanceMs?: number;
  },
  persisted?: {
    execution_deadline_ms?: number | null;
    cleanup_deadline_ms?: number | null;
    cleanup_reserve_ms?: number | null;
  }
): ExecutionBudget {
  const reserveMs =
    persisted?.cleanup_reserve_ms ?? executionCleanupReserveMs(configuredDurationMs);
  const turnDeadlineMs =
    persisted?.execution_deadline_ms ??
    now + (sandbox.turnAllowanceMs ?? configuredDurationMs - reserveMs);
  const executionDeadlineMs = Math.min(
    turnDeadlineMs,
    sandbox.providerExpiresAtMs == null ? Infinity : sandbox.providerExpiresAtMs - reserveMs
  );
  return {
    executionDeadlineMs,
    cleanupReserveMs: reserveMs,
    cleanupDeadlineMs: Math.min(
      persisted?.cleanup_deadline_ms ?? Infinity,
      executionDeadlineMs + reserveMs,
      sandbox.providerExpiresAtMs ?? Infinity
    ),
    sandboxId: sandbox.sandboxId,
    requiresStopEvidence: sandbox.requiresStopEvidence,
  };
}
