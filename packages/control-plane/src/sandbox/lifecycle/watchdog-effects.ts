import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { Logger } from "../../logger";
import { interruptionMessage } from "../../session/interruption-messages";
import type { SandboxRow } from "../../session/types";
import type { StopConfig } from "../provider";
import type { SandboxAlarmResult, SandboxGeneration } from "./ports";
import type { SandboxAccess } from "./sandbox-access";

/** Generation-pinned facts captured by the manager before alarm effects can yield. */
export interface WatchdogContext {
  sandbox: SandboxRow;
  now: number;
  providerObjectId: string | undefined;
  isCurrentGeneration: () => boolean;
}

export interface WatchdogEffectsDependencies {
  storage: {
    updateSandboxStatus(status: SandboxStatus): void;
    fenceSandboxGeneration(): void;
  };
  broadcaster: { broadcast(message: ServerMessage): void };
  sockets: {
    sendToSandbox(message: object): boolean;
    detachSandboxWebSocket(code: number, reason: string): void;
  };
  shutdown: {
    isHolding(): boolean;
    requestShutdown(
      reason: string,
      mode?: "graceful" | "emergency"
    ): Promise<"owned" | "unmanaged" | "held">;
    holdFailedRetainedBoot(reason: string, generation: SandboxGeneration): boolean;
  };
  access: Pick<SandboxAccess, "clearAccess">;
  canStopProviderSandbox: () => boolean;
  usesProviderManagedStop: () => boolean;
  snapshotRequiresShutdown: () => boolean;
  /** Count a failed attempt; returns whether the circuit breaker is now open. */
  recordSpawnFailure: (now: number, attemptStartedAt: number) => boolean;
  reportSandboxError: (reason: string) => void;
  triggerSnapshot: (reason: string) => Promise<void>;
  stopProviderSandboxSafely: (options: {
    reason: string;
    intent: StopConfig["intent"];
    providerObjectId: string | undefined;
    generationCreatedAtMs: number;
    failureMessage: string;
    level?: "warn" | "error";
  }) => Promise<boolean>;
  getLogger: () => Pick<Logger, "info" | "warn" | "error">;
}

/**
 * Fail and charge the boot before stop; providers without stop permit late
 * bridge self-heal. A fenced and stopped generation is replaced at once: the
 * prompt it was booting for may come from a bot that never sends another, so
 * waiting for the next message would strand it. The breaker bounds that chain.
 * When no replacement can follow (the breaker opened, or the stop failed and a
 * fenced generation cannot be replaced until it is confirmed stopped), the
 * prompt fails instead of waiting with nothing scheduled to retry it.
 */
export async function failConnectTimeout(
  deps: Pick<
    WatchdogEffectsDependencies,
    | "storage"
    | "broadcaster"
    | "shutdown"
    | "access"
    | "canStopProviderSandbox"
    | "recordSpawnFailure"
    | "reportSandboxError"
    | "stopProviderSandboxSafely"
    | "getLogger"
  >,
  elapsedMs: number,
  timeoutMs: number,
  ctx: WatchdogContext
): Promise<SandboxAlarmResult> {
  deps.getLogger().warn("Connecting timeout", {
    event: "sandbox.connecting_timeout",
    elapsed_ms: elapsedMs,
    timeout_ms: timeoutMs,
  });
  deps.storage.updateSandboxStatus("failed");
  const retriesExhausted = deps.recordSpawnFailure(ctx.now, ctx.sandbox.created_at);
  deps.access.clearAccess();
  const held = deps.shutdown.holdFailedRetainedBoot(
    "Sandbox failed to connect within the allowed time",
    { sandboxId: ctx.sandbox.modal_sandbox_id, createdAt: ctx.sandbox.created_at }
  );
  const replaceable = !held && deps.canStopProviderSandbox();
  let stopped = false;
  if (replaceable) {
    // Refuse a bridge arriving during stop, but don't fence an unstoppable late boot.
    deps.storage.fenceSandboxGeneration();
    stopped = await deps.stopProviderSandboxSafely({
      reason: "connecting_timeout",
      intent: "destroy",
      providerObjectId: ctx.providerObjectId,
      generationCreatedAtMs: ctx.sandbox.created_at,
      failureMessage: "Provider stop failed after connecting timeout",
    });
  }
  deps.broadcaster.broadcast({ type: "sandbox_status", status: "failed" });
  if (held) {
    deps.reportSandboxError("Sandbox failed to connect within the allowed time.");
    return "sandbox_failed";
  }
  if (!replaceable) {
    deps.reportSandboxError(
      "Sandbox failed to connect within the allowed time. It will be retried on your next message."
    );
    return "sandbox_failed";
  }
  const reason = retriesExhausted
    ? "Sandbox failed to connect within the allowed time after repeated attempts."
    : !stopped
      ? "Sandbox failed to connect within the allowed time and could not be stopped for a retry."
      : "Sandbox failed to connect within the allowed time. Queued prompts will be retried on a fresh sandbox.";
  deps.reportSandboxError(reason);
  // A launch that replaced this generation during stop owns the queue now.
  if (!ctx.isCurrentGeneration()) return "sandbox_failed";
  return retriesExhausted || !stopped
    ? { kind: "connect_timeout_unrecoverable", reason }
    : "sandbox_terminated";
}

/** Preserve a ready workspace, but never turn an incomplete boot into a restore point. */
export async function terminateStaleHeartbeat(
  deps: Pick<
    WatchdogEffectsDependencies,
    | "storage"
    | "broadcaster"
    | "sockets"
    | "shutdown"
    | "access"
    | "canStopProviderSandbox"
    | "usesProviderManagedStop"
    | "snapshotRequiresShutdown"
    | "recordSpawnFailure"
    | "triggerSnapshot"
    | "stopProviderSandboxSafely"
    | "getLogger"
  >,
  ageMs: number,
  isBooting: boolean,
  timeoutMs: number,
  ctx: WatchdogContext
): Promise<SandboxAlarmResult> {
  deps.getLogger().warn("Heartbeat stale", {
    event: "sandbox.heartbeat_stale",
    last_heartbeat_ms: ageMs,
    threshold_ms: timeoutMs,
    sandbox_status: ctx.sandbox.status,
  });
  if (!isBooting && deps.snapshotRequiresShutdown()) {
    // A missing runtime cannot drain; the coordinator captures and retires the source.
    const ownership = await deps.shutdown.requestShutdown("heartbeat_timeout", "emergency");
    // Owned: the shutdown failed the prompt as it claimed the source. Held: a
    // save already owns the source and fails nothing, so the watchdog reports
    // the lost runtime itself.
    if (ownership !== "unmanaged")
      return ownership === "held" && ctx.isCurrentGeneration() ? heartbeatLost() : "no_action";
  }
  deps.storage.updateSandboxStatus("stale");
  if (isBooting) deps.recordSpawnFailure(ctx.now, ctx.sandbox.created_at);
  deps.access.clearAccess();
  deps.broadcaster.broadcast({ type: "sandbox_status", status: "stale" });

  const preservesProviderState = deps.usesProviderManagedStop();
  if (preservesProviderState || isBooting) {
    // No snapshot of a half-booted filesystem or shutdown to an absent bridge.
    if (deps.canStopProviderSandbox()) {
      await deps.stopProviderSandboxSafely({
        reason: "heartbeat_timeout",
        intent: preservesProviderState ? "preserve" : "destroy",
        providerObjectId: ctx.providerObjectId,
        generationCreatedAtMs: ctx.sandbox.created_at,
        failureMessage: "Provider stop failed after heartbeat timeout",
      });
    }
  } else {
    const outcome = await snapshotAndStopStaleSandbox(deps, ctx);
    if (outcome === "held") return heartbeatLost();
    if (outcome === "superseded" || !ctx.isCurrentGeneration()) return "no_action";
    deps.sockets.sendToSandbox({ type: "shutdown" });
  }

  if (!ctx.isCurrentGeneration()) return "no_action";
  deps.sockets.detachSandboxWebSocket(1000, "Heartbeat stale");
  return "sandbox_terminated";
}

/** The runtime is gone, but its save holds the source: no termination will fail its prompt. */
function heartbeatLost(): SandboxAlarmResult {
  return { kind: "heartbeat_lost", reason: interruptionMessage("heartbeat_timeout") };
}

/** Await capture before explicit stop; otherwise leave capture detached as before. */
export async function snapshotAndStopStaleSandbox(
  deps: Pick<
    WatchdogEffectsDependencies,
    | "canStopProviderSandbox"
    | "triggerSnapshot"
    | "shutdown"
    | "stopProviderSandboxSafely"
    | "getLogger"
  >,
  ctx: WatchdogContext
): Promise<"stopped" | "held" | "superseded"> {
  if (!deps.canStopProviderSandbox()) {
    deps.triggerSnapshot("heartbeat_timeout").catch((e) =>
      deps.getLogger().error("Heartbeat snapshot failed", {
        error: e instanceof Error ? e : String(e),
      })
    );
    return "stopped";
  }

  await deps.triggerSnapshot("heartbeat_timeout");
  if (!ctx.isCurrentGeneration()) return "superseded";
  // An unconfirmed save keeps the source for recovery; nothing may stop it.
  if (deps.shutdown.isHolding()) return "held";
  await deps.stopProviderSandboxSafely({
    reason: "heartbeat_timeout",
    intent: "destroy",
    providerObjectId: ctx.providerObjectId,
    generationCreatedAtMs: ctx.sandbox.created_at,
    failureMessage: "Provider stop failed after heartbeat timeout",
  });
  return "stopped";
}

/** Shutdown owns inactivity first; only unmanaged work uses the legacy fallback. */
export async function stopForInactivity(
  deps: Pick<
    WatchdogEffectsDependencies,
    | "storage"
    | "broadcaster"
    | "sockets"
    | "shutdown"
    | "access"
    | "canStopProviderSandbox"
    | "usesProviderManagedStop"
    | "triggerSnapshot"
    | "stopProviderSandboxSafely"
    | "getLogger"
  >,
  ctx: WatchdogContext
): Promise<SandboxAlarmResult> {
  const ownership = await deps.shutdown.requestShutdown("inactivity_timeout");
  if (ownership !== "unmanaged") return "no_action";

  // Block reconnect before retiring access or yielding to capture/stop.
  deps.storage.updateSandboxStatus("stopped");
  deps.access.clearAccess();
  deps.broadcaster.broadcast({ type: "sandbox_status", status: "stopped" });

  const preservesProviderState = deps.usesProviderManagedStop();
  if (preservesProviderState) {
    await deps.stopProviderSandboxSafely({
      reason: "inactivity_timeout",
      intent: "preserve",
      providerObjectId: ctx.providerObjectId,
      generationCreatedAtMs: ctx.sandbox.created_at,
      failureMessage: "Provider stop failed after inactivity timeout",
      level: "error",
    });
  } else {
    await deps.triggerSnapshot("inactivity_timeout");
    if (deps.shutdown.isHolding()) return "no_action";
    if (!ctx.isCurrentGeneration()) return "no_action";
    deps.sockets.sendToSandbox({ type: "shutdown" });
    if (deps.canStopProviderSandbox()) {
      await deps.stopProviderSandboxSafely({
        reason: "inactivity_timeout",
        intent: "destroy",
        providerObjectId: ctx.providerObjectId,
        generationCreatedAtMs: ctx.sandbox.created_at,
        failureMessage: "Provider stop failed after inactivity timeout",
        level: "error",
      });
    }
  }

  if (!ctx.isCurrentGeneration()) return "no_action";
  deps.sockets.detachSandboxWebSocket(1000, "Inactivity timeout");
  deps.broadcaster.broadcast({
    type: "sandbox_warning",
    message: preservesProviderState
      ? "Sandbox stopped due to inactivity"
      : "Sandbox stopped due to inactivity, snapshot saved",
  });
  return "sandbox_terminated";
}
