import { describe, expect, it } from "vitest";
import { DEFAULT_HEARTBEAT_CONFIG } from "../sandbox/lifecycle/decisions";
import {
  decideCheckpointSettlement,
  type CheckpointSettlementInput,
} from "./checkpoint-settlement";

const SETTLE_AT_MS = 430_000;
const HEARTBEAT_TIMEOUT_MS = DEFAULT_HEARTBEAT_CONFIG.timeoutMs;

function input(overrides: Partial<CheckpointSettlementInput> = {}): CheckpointSettlementInput {
  return {
    op: {
      id: "op-1",
      kind: "checkpoint",
      reason: "execution_complete",
      after: "continue",
      attempt: 1,
      deadlineAtMs: SETTLE_AT_MS - 30_000,
      settleAtMs: SETTLE_AT_MS,
    },
    phase: "running",
    owned: false,
    now: SETTLE_AT_MS,
    drainAtMs: null,
    row: { status: "snapshotting", lastHeartbeat: SETTLE_AT_MS - 1_000 },
    heartbeat: DEFAULT_HEARTBEAT_CONFIG,
    ...overrides,
  };
}

const op = input().op;

describe("decideCheckpointSettlement", () => {
  it.each<
    [string, Partial<CheckpointSettlementInput>, ReturnType<typeof decideCheckpointSettlement>]
  >([
    [
      "waits for the settle time",
      { now: SETTLE_AT_MS - 1 },
      { kind: "wait", untilMs: SETTLE_AT_MS },
    ],
    [
      "never waits past the drain deadline",
      { now: 100_000, drainAtMs: 200_000 },
      { kind: "wait", untilMs: 200_000 },
    ],
    ["releases a live runtime", {}, { kind: "release" }],
    [
      "releases a row already ready",
      { row: { status: "ready", lastHeartbeat: SETTLE_AT_MS - 1_000 } },
      { kind: "release" },
    ],
    [
      "lets a due drain claim the checkpoint before releasing it",
      { drainAtMs: SETTLE_AT_MS },
      { kind: "drain" },
    ],
    [
      "defers once for a stale heartbeat",
      { row: { status: "snapshotting", lastHeartbeat: 100_000 } },
      { kind: "defer", untilMs: SETTLE_AT_MS + HEARTBEAT_TIMEOUT_MS },
    ],
    [
      "bounds the deferral by the drain deadline",
      { row: { status: "snapshotting", lastHeartbeat: 100_000 }, drainAtMs: SETTLE_AT_MS + 10_000 },
      { kind: "defer", untilMs: SETTLE_AT_MS + 10_000 },
    ],
    [
      "defers when no heartbeat was ever recorded",
      { row: { status: "snapshotting", lastHeartbeat: null } },
      { kind: "defer", untilMs: SETTLE_AT_MS + HEARTBEAT_TIMEOUT_MS },
    ],
    [
      "waits out a deferral",
      { op: { ...op, deferredUntilMs: SETTLE_AT_MS + 5_000 } },
      { kind: "wait", untilMs: SETTLE_AT_MS + 5_000 },
    ],
    [
      "holds once the deferral ends with the heartbeat still stale",
      {
        op: { ...op, deferredUntilMs: SETTLE_AT_MS },
        row: { status: "snapshotting", lastHeartbeat: 100_000 },
      },
      { kind: "hold" },
    ],
    [
      "holds a dead row",
      { row: { status: "stopped", lastHeartbeat: SETTLE_AT_MS } },
      { kind: "hold" },
    ],
    ["holds a missing row", { row: null }, { kind: "hold" }],
    [
      "holds a runtime that reported a fatal error",
      { op: { ...op, runtimeFailedAtMs: SETTLE_AT_MS - 1 } },
      { kind: "hold" },
    ],
    [
      "waits for an owned call to end",
      { owned: true, now: SETTLE_AT_MS - 1 },
      { kind: "wait", untilMs: SETTLE_AT_MS },
    ],
    [
      "draining: waits for the settle time",
      { phase: "draining", now: SETTLE_AT_MS - 1 },
      { kind: "wait", untilMs: SETTLE_AT_MS },
    ],
    [
      "draining: hands off without liveness evidence",
      { phase: "draining", row: { status: "stale", lastHeartbeat: 100_000 } },
      { kind: "handoff" },
    ],
    [
      "draining: lets an owned call's end re-drive the drain",
      { phase: "draining", owned: true },
      { kind: "wait", untilMs: null },
    ],
  ])("%s", (_name, overrides, expected) => {
    expect(decideCheckpointSettlement(input(overrides))).toEqual(expected);
  });
});
