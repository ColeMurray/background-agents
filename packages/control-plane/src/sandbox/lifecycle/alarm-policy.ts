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
  type InactivityConfig,
} from "./decisions";

export type AlarmSandbox = Readonly<
  Pick<SandboxRow, "status" | "created_at" | "last_heartbeat" | "last_activity">
>;

export interface AlarmPolicyConfig {
  connectingTimeout: ConnectingTimeoutConfig;
  heartbeat: HeartbeatConfig;
  bootBudget: BootBudgetConfig;
  inactivity: InactivityConfig;
}

/**
 * What the alarm found, never what to do about it. Every variant names a
 * condition the manager then chooses a recovery for, so the policy carries no
 * rendered text and no effect ordering.
 */
export type AlarmFinding =
  | { outcome: "terminal" }
  | { outcome: "connecting_timeout"; elapsedMs: number }
  | { outcome: "heartbeat_stale"; ageMs: number; isBooting: boolean }
  | { outcome: "boot_budget_exceeded"; elapsedMs: number }
  | { outcome: "inactivity_timeout" }
  | { outcome: "inactivity_warning"; extensionMs: number }
  | { outcome: "healthy"; nextCheckMs: number };

/** Ordered policy only; storage, socket and provider effects belong to the manager. */
export function evaluateAlarmPolicy(
  sandbox: AlarmSandbox,
  config: AlarmPolicyConfig,
  now: number,
  connectedClientCount: number
): AlarmFinding {
  if (isDeadSandboxStatus(sandbox.status)) return { outcome: "terminal" };

  const connecting = evaluateConnectingTimeout(
    sandbox.status,
    sandbox.created_at,
    config.connectingTimeout,
    now,
    sandbox.last_heartbeat !== null
  );
  if (connecting.isTimedOut) {
    return { outcome: "connecting_timeout", elapsedMs: connecting.elapsedMs };
  }

  const heartbeat = evaluateHeartbeatHealth(sandbox.last_heartbeat, config.heartbeat, now);
  if (heartbeat.isStale) {
    // A stale boot counts toward the breaker and must never become a restore point.
    return {
      outcome: "heartbeat_stale",
      ageMs: heartbeat.ageMs,
      isBooting: sandbox.status === "spawning" || sandbox.status === "connecting",
    };
  }

  const budget = evaluateBootBudget(sandbox.status, sandbox.created_at, config.bootBudget, now);
  if (budget.isExceeded) {
    return { outcome: "boot_budget_exceeded", elapsedMs: budget.elapsedMs };
  }

  const inactivity = evaluateInactivityTimeout(
    { lastActivity: sandbox.last_activity, status: sandbox.status, connectedClientCount },
    config.inactivity,
    now
  );
  switch (inactivity.action) {
    case "timeout":
      return { outcome: "inactivity_timeout" };
    case "extend":
      return { outcome: "inactivity_warning", extensionMs: inactivity.extensionMs };
    case "schedule":
      return { outcome: "healthy", nextCheckMs: inactivity.nextCheckMs };
  }
}
