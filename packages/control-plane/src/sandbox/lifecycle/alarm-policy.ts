import {
  sandboxBootPhaseSchema,
  type SandboxBootPhase,
} from "@open-inspect/shared/types/sandbox-events";
import type { SandboxRow } from "../../session/types";
import {
  evaluateBootBudget,
  evaluateConnectingTimeout,
  evaluateHeartbeatHealth,
  evaluateInactivityTimeout,
  isDeadSandboxStatus,
  type BootBudgetConfig,
  type ConnectingTimeoutConfig,
  type HeartbeatConfig,
  type InactivityAction,
  type InactivityConfig,
} from "./decisions";

export type AlarmSandbox = Readonly<
  Pick<SandboxRow, "status" | "created_at" | "last_heartbeat" | "last_activity" | "boot_phase">
>;

export interface AlarmPolicyConfig {
  connectingTimeout: ConnectingTimeoutConfig;
  heartbeat: HeartbeatConfig;
  bootBudget: BootBudgetConfig;
  inactivity: InactivityConfig;
}

export type AlarmDecision =
  | { action: "no_action" }
  | { action: "connecting_timeout"; elapsedMs: number }
  | { action: "heartbeat_stale"; ageMs: number; isBooting: boolean }
  | { action: "boot_budget_exceeded"; elapsedMs: number; reason: string }
  | InactivityAction;

/** Ordered policy only; storage, socket and provider effects belong to the manager. */
export function evaluateAlarmPolicy(
  sandbox: AlarmSandbox | null,
  config: AlarmPolicyConfig,
  now: number,
  connectedClientCount: number
): AlarmDecision {
  if (!sandbox || isDeadSandboxStatus(sandbox.status)) return { action: "no_action" };

  const connecting = evaluateConnectingTimeout(
    sandbox.status,
    sandbox.created_at,
    config.connectingTimeout,
    now,
    sandbox.last_heartbeat !== null
  );
  if (connecting.isTimedOut) {
    return { action: "connecting_timeout", elapsedMs: connecting.elapsedMs };
  }

  const heartbeat = evaluateHeartbeatHealth(sandbox.last_heartbeat, config.heartbeat, now);
  if (heartbeat.isStale) {
    // A stale boot counts toward the breaker and must never become a restore point.
    return {
      action: "heartbeat_stale",
      ageMs: heartbeat.ageMs ?? 0,
      isBooting: sandbox.status === "spawning" || sandbox.status === "connecting",
    };
  }

  const budget = evaluateBootBudget(sandbox.status, sandbox.created_at, config.bootBudget, now);
  if (budget.isExceeded) {
    const budgetMinutes = Math.round(config.bootBudget.timeoutMs / 60_000);
    return {
      action: "boot_budget_exceeded",
      elapsedMs: budget.elapsedMs,
      reason:
        `Sandbox boot exceeded ${budgetMinutes} minutes while ${describeBootPhase(sandbox.boot_phase)}. ` +
        "Raise SANDBOX_BOOT_TIMEOUT_MS if the boot legitimately needs longer, or make it return sooner.",
    };
  }

  return evaluateInactivityTimeout(
    { lastActivity: sandbox.last_activity, status: sandbox.status, connectedClientCount },
    config.inactivity,
    now
  );
}

/** Name the script where possible so operators know which boot step to inspect. */
function describeBootPhase(bootPhaseJson: string | null): string {
  let phase: SandboxBootPhase | null = null;
  if (bootPhaseJson) {
    try {
      const parsed = sandboxBootPhaseSchema.safeParse(JSON.parse(bootPhaseJson));
      phase = parsed.success ? parsed.data : null;
    } catch {
      phase = null;
    }
  }
  if (!phase) return "booting";
  const repo = phase.repoOwner && phase.repoName ? ` for ${phase.repoOwner}/${phase.repoName}` : "";
  switch (phase.phase) {
    case "starting":
      return "starting the runtime";
    case "sync":
      return `cloning${repo}`;
    case "setup":
      return `running setup.sh${repo}`;
    case "start":
      return `running start.sh${repo}`;
    case "skills":
      return "installing managed skills";
    case "harness":
      return "starting the agent";
  }
}
