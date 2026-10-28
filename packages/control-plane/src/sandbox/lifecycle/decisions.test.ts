import { describe, expect, it } from "vitest";
import { evaluateAlarmPolicy } from "./alarm-policy";
import {
  DEFAULT_BOOT_BUDGET_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  evaluateCircuitBreaker,
  evaluateInactivityTimeout,
  evaluateSpawnDecision,
  inactivityConfigFor,
} from "./decisions";

describe("inactivity timeout policy", () => {
  const now = 10_000_000;
  const policy = DEFAULT_INACTIVITY_CONFIG;

  describe.each([
    { source: "automation", timeoutMs: 120_000 },
    { source: "github-bot", timeoutMs: 120_000 },
    { source: "agent", timeoutMs: 120_000 },
    { source: "user", timeoutMs: 600_000 },
    { source: "linear-bot", timeoutMs: 600_000 },
    { source: "slack-bot", timeoutMs: 600_000 },
    { source: undefined, timeoutMs: 600_000 },
  ] as const)("$source sessions", ({ source, timeoutMs }) => {
    const inactivity = inactivityConfigFor(policy, source);
    const config = {
      connectingTimeout: DEFAULT_CONNECTING_TIMEOUT_CONFIG,
      heartbeat: DEFAULT_HEARTBEAT_CONFIG,
      bootBudget: DEFAULT_BOOT_BUDGET_CONFIG,
      inactivity,
    };

    it.each([
      {
        name: "schedules just before the cutoff",
        offsetMs: -1,
        clients: 0,
        decision: { action: "schedule", nextCheckMs: policy.minCheckIntervalMs },
        finding: { outcome: "healthy", nextCheckMs: policy.minCheckIntervalMs },
      },
      {
        name: "times out exactly at the cutoff",
        offsetMs: 0,
        clients: 0,
        decision: { action: "timeout", idleMs: timeoutMs },
        finding: { outcome: "inactivity_timeout", idleMs: timeoutMs, timeoutMs },
      },
      {
        name: "extends at the cutoff with connected clients",
        offsetMs: 0,
        clients: 2,
        decision: { action: "extend", extensionMs: policy.extensionMs },
        finding: { outcome: "inactivity_warning", extensionMs: policy.extensionMs },
      },
    ] as const)("$name", ({ offsetMs, clients, decision, finding }) => {
      expect(inactivity).toEqual({
        timeoutMs,
        extensionMs: policy.extensionMs,
        minCheckIntervalMs: policy.minCheckIntervalMs,
      });
      const lastActivity = now - timeoutMs - offsetMs;

      expect(
        evaluateInactivityTimeout(
          { status: "ready", lastActivity, connectedClientCount: clients },
          inactivity,
          now
        )
      ).toEqual(decision);
      expect(
        evaluateAlarmPolicy(
          { status: "ready", created_at: 0, last_heartbeat: now, last_activity: lastActivity },
          config,
          now,
          clients
        )
      ).toEqual(finding);
    });
  });
});

describe("heartbeat reconnect grace", () => {
  const now = 10_000_000;
  const config = {
    connectingTimeout: DEFAULT_CONNECTING_TIMEOUT_CONFIG,
    heartbeat: DEFAULT_HEARTBEAT_CONFIG,
    bootBudget: DEFAULT_BOOT_BUDGET_CONFIG,
    inactivity: DEFAULT_INACTIVITY_CONFIG,
  };
  const { timeoutMs, reconnectGraceMs } = DEFAULT_HEARTBEAT_CONFIG;
  const evaluate = (status: "ready" | "connecting", ageMs: number) =>
    evaluateAlarmPolicy(
      { status, created_at: now - 1, last_heartbeat: now - ageMs, last_activity: now },
      config,
      now,
      0
    );

  it("waits out the grace for a booted sandbox whose heartbeat just went stale", () => {
    const ageMs = timeoutMs + 1;
    expect(evaluate("ready", ageMs)).toEqual({
      outcome: "heartbeat_unconfirmed",
      ageMs,
      graceEndsAtMs: now + reconnectGraceMs,
    });
    expect(evaluate("ready", timeoutMs + reconnectGraceMs)).toMatchObject({
      outcome: "heartbeat_unconfirmed",
      graceEndsAtMs: now + 1,
    });
  });

  it("finds a booted sandbox stale once the grace has passed", () => {
    const ageMs = timeoutMs + reconnectGraceMs + 1;
    expect(evaluate("ready", ageMs)).toEqual({
      outcome: "heartbeat_stale",
      ageMs,
      isBooting: false,
    });
  });

  it("gives a booting sandbox no grace", () => {
    const ageMs = timeoutMs + 1;
    expect(evaluate("connecting", ageMs)).toEqual({
      outcome: "heartbeat_stale",
      ageMs,
      isBooting: true,
    });
  });
});

describe("watchdog retry cadence", () => {
  it("lets a failed attempt retry even inside the spawn cooldown", () => {
    expect(
      evaluateSpawnDecision(
        {
          status: "failed",
          createdAt: 0,
          snapshotImageId: null,
          snapshotRuntimeVersion: null,
          hasActiveWebSocket: false,
          lastHeartbeat: null,
        },
        DEFAULT_SPAWN_CONFIG,
        DEFAULT_SPAWN_CONFIG.cooldownMs - 1,
        false
      )
    ).toEqual({ action: "spawn" });
  });

  it("retains consecutive failures one watchdog cycle apart until the circuit opens", () => {
    const cadenceMs = DEFAULT_CONNECTING_TIMEOUT_CONFIG.timeoutMs;
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.windowMs).toBeGreaterThan(cadenceMs);

    for (
      let failureCount = 1;
      failureCount <= DEFAULT_CIRCUIT_BREAKER_CONFIG.threshold;
      failureCount++
    ) {
      const lastFailureTime = failureCount * cadenceMs;
      const decision = evaluateCircuitBreaker(
        { failureCount, lastFailureTime },
        DEFAULT_CIRCUIT_BREAKER_CONFIG,
        lastFailureTime + cadenceMs
      );
      expect(decision.shouldReset).toBe(false);
      expect(decision.shouldProceed).toBe(failureCount < DEFAULT_CIRCUIT_BREAKER_CONFIG.threshold);
    }
  });
});
