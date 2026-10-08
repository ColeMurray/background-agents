import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import {
  evaluateHeartbeatHealth,
  isDeadSandboxStatus,
  type HeartbeatConfig,
} from "../sandbox/lifecycle/decisions";
import type { CaptureOperation } from "./sandbox-shutdown-repository";

/**
 * What to do with a routine checkpoint whose exclusion is still held.
 *
 * - `wait`: the request may still be running; wake at `untilMs`, or not at
 *   all when the owner's own end re-drives the decision.
 * - `drain`: a due lifetime drain claims the session first; the shutdown
 *   takes over the checkpoint at its settle time.
 * - `release`: hand the live runtime back to the session.
 * - `defer`: wait once for a reconnecting runtime to report.
 * - `hold`: keep the source for the user.
 * - `handoff`: the claiming shutdown captures the source itself.
 */
export type CheckpointSettlement =
  | { kind: "wait"; untilMs: number | null }
  | { kind: "drain" }
  | { kind: "release" }
  | { kind: "defer"; untilMs: number }
  | { kind: "hold" }
  | { kind: "handoff" };

export interface CheckpointSettlementInput {
  op: CaptureOperation;
  phase: "running" | "draining";
  /** This instance is still awaiting the provider call. */
  owned: boolean;
  now: number;
  drainAtMs: number | null;
  row: { status: SandboxStatus; lastHeartbeat: number | null } | null;
  heartbeat: HeartbeatConfig;
}

/**
 * Until the settle time the provider may still be capturing, so nothing may
 * capture or stop the source. After it, only a runtime that is demonstrably
 * live may be handed back; its workspace was never stopped or altered, and
 * the next checkpoint captures it. A shutdown never needs that evidence: it
 * captures the source itself.
 */
export function decideCheckpointSettlement(input: CheckpointSettlementInput): CheckpointSettlement {
  const { op, now, drainAtMs } = input;
  if (input.phase === "draining") {
    if (now < op.settleAtMs) return { kind: "wait", untilMs: op.settleAtMs };
    return input.owned ? { kind: "wait", untilMs: null } : { kind: "handoff" };
  }
  if (drainAtMs !== null && now >= drainAtMs) return { kind: "drain" };
  // A wait never outlasts the drain deadline.
  const bound = (untilMs: number) => Math.min(untilMs, drainAtMs ?? Number.POSITIVE_INFINITY);
  // The owner's own end decides; until then keep its settle and drain alarms.
  if (input.owned)
    return { kind: "wait", untilMs: now < op.settleAtMs ? bound(op.settleAtMs) : drainAtMs };
  const dueAtMs = op.deferredUntilMs ?? op.settleAtMs;
  if (now < dueAtMs) return { kind: "wait", untilMs: bound(dueAtMs) };
  const { row } = input;
  if (!row || isDeadSandboxStatus(row.status) || op.runtimeFailedAtMs !== undefined)
    return { kind: "hold" };
  const live =
    (row.status === "snapshotting" || row.status === "ready") &&
    row.lastHeartbeat !== null &&
    !evaluateHeartbeatHealth(row.lastHeartbeat, input.heartbeat, now).isStale;
  if (live) return { kind: "release" };
  if (op.deferredUntilMs === undefined)
    return { kind: "defer", untilMs: bound(now + input.heartbeat.timeoutMs) };
  return { kind: "hold" };
}
