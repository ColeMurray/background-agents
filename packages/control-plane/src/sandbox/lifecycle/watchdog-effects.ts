import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { Logger } from "../../logger";
import type { SandboxRow } from "../../session/types";
import { parseStoredSandboxBootPhase, sandboxBootPhaseLogFields } from "../boot-phase";
import type { StopConfig } from "../provider";
import { formatBootBudgetFailure } from "./boot-failure-message";
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
  recordSpawnFailure: (now: number, attemptStartedAt: number) => void;
  reportSandboxError: (reason: string) => void;
  triggerSnapshot: (reason: string) => Promise<void>;
  stopProviderSandboxSafely: (options: {
    reason: string;
    intent: StopConfig["intent"];
    providerObjectId: string | undefined;
    generationCreatedAtMs: number;
    failureMessage: string;
    level?: "warn" | "error";
  }) => Promise<void>;
  /** Only this explicit provider stop runs inside the manager's termination guard. */
  stopBootBudgetSandbox: (
    providerObjectId: string | undefined,
    generationCreatedAtMs: number
  ) => Promise<void>;
  getLogger: () => Pick<Logger, "info" | "warn" | "error">;
}

/** Fail and charge the boot before stop; providers without stop permit late bridge self-heal. */
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
  deps.recordSpawnFailure(ctx.now, ctx.sandbox.created_at);
  deps.access.clearAccess();
  const held = deps.shutdown.holdFailedRetainedBoot(
    "Sandbox failed to connect within the allowed time",
    { sandboxId: ctx.sandbox.modal_sandbox_id, createdAt: ctx.sandbox.created_at }
  );
  if (!held && deps.canStopProviderSandbox()) {
    // Refuse a bridge arriving during stop, but don't fence an unstoppable late boot.
    deps.storage.fenceSandboxGeneration();
    await deps.stopProviderSandboxSafely({
      reason: "connecting_timeout",
      intent: "destroy",
      providerObjectId: ctx.providerObjectId,
      generationCreatedAtMs: ctx.sandbox.created_at,
      failureMessage: "Provider stop failed after connecting timeout",
    });
  }
  deps.broadcaster.broadcast({ type: "sandbox_status", status: "failed" });
  deps.reportSandboxError(
    held
      ? "Sandbox failed to connect within the allowed time."
      : "Sandbox failed to connect within the allowed time. It will be retried on your next message."
  );
  return "sandbox_failed";
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
    if (ownership !== "unmanaged") return "no_action";
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
    if ((await snapshotAndStopStaleSandbox(deps, ctx)) === "abandoned") return "no_action";
    if (!ctx.isCurrentGeneration()) return "no_action";
    deps.sockets.sendToSandbox({ type: "shutdown" });
  }

  if (!ctx.isCurrentGeneration()) return "no_action";
  deps.sockets.detachSandboxWebSocket(1000, "Heartbeat stale");
  return "sandbox_terminated";
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
): Promise<"stopped" | "abandoned"> {
  if (!deps.canStopProviderSandbox()) {
    deps.triggerSnapshot("heartbeat_timeout").catch((e) =>
      deps.getLogger().error("Heartbeat snapshot failed", {
        error: e instanceof Error ? e : String(e),
      })
    );
    return "stopped";
  }

  await deps.triggerSnapshot("heartbeat_timeout");
  if (deps.shutdown.isHolding()) return "abandoned";
  if (!ctx.isCurrentGeneration()) return "abandoned";
  await deps.stopProviderSandboxSafely({
    reason: "heartbeat_timeout",
    intent: "destroy",
    providerObjectId: ctx.providerObjectId,
    generationCreatedAtMs: ctx.sandbox.created_at,
    failureMessage: "Provider stop failed after heartbeat timeout",
  });
  return "stopped";
}

/** Send, fence, fail/publish and detach before the manager guards explicit provider stop. */
export async function failBootBudget(
  deps: Pick<
    WatchdogEffectsDependencies,
    | "storage"
    | "broadcaster"
    | "sockets"
    | "shutdown"
    | "access"
    | "canStopProviderSandbox"
    | "recordSpawnFailure"
    | "reportSandboxError"
    | "stopBootBudgetSandbox"
    | "getLogger"
  >,
  elapsedMs: number,
  timeoutMs: number,
  ctx: WatchdogContext
): Promise<SandboxAlarmResult> {
  const bootPhase = parseStoredSandboxBootPhase(ctx.sandbox.boot_phase);
  const reason = formatBootBudgetFailure(ctx.sandbox.boot_phase, timeoutMs);
  deps.getLogger().warn("Boot budget exceeded", {
    event: "sandbox.boot_budget",
    ...sandboxBootPhaseLogFields(bootPhase),
    elapsed_ms: elapsedMs,
    timeout_ms: timeoutMs,
  });
  const held = deps.shutdown.holdFailedRetainedBoot(reason, {
    sandboxId: ctx.sandbox.modal_sandbox_id,
    createdAt: ctx.sandbox.created_at,
  });
  if (!held) {
    deps.sockets.sendToSandbox({ type: "shutdown" });
    deps.storage.fenceSandboxGeneration();
  }
  deps.storage.updateSandboxStatus("failed");
  deps.recordSpawnFailure(ctx.now, ctx.sandbox.created_at);
  deps.access.clearAccess();
  deps.broadcaster.broadcast({ type: "sandbox_status", status: "failed" });
  deps.reportSandboxError(reason);
  if (held) return { kind: "boot_budget_exceeded", reason };
  deps.sockets.detachSandboxWebSocket(1000, "Boot budget exceeded");
  if (deps.canStopProviderSandbox()) {
    await deps.stopBootBudgetSandbox(ctx.providerObjectId, ctx.sandbox.created_at);
  }
  return { kind: "boot_budget_exceeded", reason };
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
  timeoutMs: number,
  ctx: WatchdogContext
): Promise<SandboxAlarmResult> {
  const ownership = await deps.shutdown.requestShutdown("inactivity_timeout");
  if (ownership !== "unmanaged") return "no_action";

  deps.getLogger().info("Inactivity timeout", {
    event: "sandbox.timeout",
    last_activity: ctx.sandbox.last_activity,
    timeout_ms: timeoutMs,
  });
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
