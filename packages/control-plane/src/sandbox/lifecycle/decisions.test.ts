import { describe, expect, it } from "vitest";
import { evaluateAlarmPolicy } from "./alarm-policy";
import {
  DEFAULT_BOOT_BUDGET_CONFIG,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  MIN_UNATTENDED_INACTIVITY_TIMEOUT_MS,
  evaluateCircuitBreaker,
  evaluateInactivityTimeout,
  evaluateSpawnDecision,
  getInactivityTimeoutMs,
  isUnattendedSessionSource,
  resolveUnattendedInactivityTimeoutMs,
} from "./decisions";

describe("inactivity timeout policy", () => {
  const now = 10_000_000;
  const config = {
    connectingTimeout: DEFAULT_CONNECTING_TIMEOUT_CONFIG,
    heartbeat: DEFAULT_HEARTBEAT_CONFIG,
    bootBudget: DEFAULT_BOOT_BUDGET_CONFIG,
    inactivity: DEFAULT_INACTIVITY_CONFIG,
  };

  describe.each([
    { source: "automation", unattended: true, timeoutMs: 120_000 },
    { source: "github-bot", unattended: true, timeoutMs: 120_000 },
    { source: "agent", unattended: true, timeoutMs: 120_000 },
    { source: "user", unattended: false, timeoutMs: 600_000 },
    { source: "linear-bot", unattended: false, timeoutMs: 600_000 },
    { source: "slack-bot", unattended: false, timeoutMs: 600_000 },
    { source: undefined, unattended: false, timeoutMs: 600_000 },
  ] as const)("$source sessions", ({ source, unattended, timeoutMs }) => {
    it.each([
      {
        name: "schedules just before the cutoff",
        offsetMs: -1,
        clients: 0,
        decision: { action: "schedule", nextCheckMs: config.inactivity.minCheckIntervalMs },
        finding: { outcome: "healthy", nextCheckMs: config.inactivity.minCheckIntervalMs },
      },
      {
        name: "times out exactly at the cutoff",
        offsetMs: 0,
        clients: 0,
        decision: { action: "timeout" },
        finding: { outcome: "inactivity_timeout" },
      },
      {
        name: "extends at the cutoff with connected clients",
        offsetMs: 0,
        clients: 2,
        decision: { action: "extend", extensionMs: config.inactivity.extensionMs },
        finding: { outcome: "inactivity_warning", extensionMs: config.inactivity.extensionMs },
      },
    ] as const)("$name", ({ offsetMs, clients, decision, finding }) => {
      expect(isUnattendedSessionSource(source)).toBe(unattended);
      expect(getInactivityTimeoutMs(config.inactivity, unattended)).toBe(timeoutMs);
      const lastActivity = now - timeoutMs - offsetMs;

      expect(
        evaluateInactivityTimeout(
          { status: "ready", lastActivity, connectedClientCount: clients, unattended },
          config.inactivity,
          now
        )
      ).toEqual(decision);
      expect(
        evaluateAlarmPolicy(
          { status: "ready", created_at: 0, last_heartbeat: now, last_activity: lastActivity },
          config,
          now,
          clients,
          unattended
        )
      ).toEqual(finding);
    });
  });

  it.each([
    { timeoutMs: 600_000, unattendedTimeoutMs: 600_000 },
    { timeoutMs: 600_000, unattendedTimeoutMs: 900_000 },
    { timeoutMs: 60_000, unattendedTimeoutMs: 120_000 },
  ])(
    "caps unattended $unattendedTimeoutMs ms at the regular $timeoutMs ms cutoff",
    ({ timeoutMs, unattendedTimeoutMs }) => {
      const cappedConfig = {
        ...config,
        inactivity: { ...config.inactivity, timeoutMs, unattendedTimeoutMs },
      };
      expect(getInactivityTimeoutMs(cappedConfig.inactivity, false)).toBe(timeoutMs);
      expect(getInactivityTimeoutMs(cappedConfig.inactivity, true)).toBe(timeoutMs);

      for (const offsetMs of [-1, 0]) {
        const lastActivity = now - timeoutMs - offsetMs;
        expect(
          evaluateInactivityTimeout(
            { status: "ready", lastActivity, connectedClientCount: 0, unattended: true },
            cappedConfig.inactivity,
            now
          )
        ).toEqual(
          offsetMs === -1
            ? { action: "schedule", nextCheckMs: cappedConfig.inactivity.minCheckIntervalMs }
            : { action: "timeout" }
        );
        expect(
          evaluateAlarmPolicy(
            { status: "ready", created_at: 0, last_heartbeat: now, last_activity: lastActivity },
            cappedConfig,
            now,
            0,
            true
          )
        ).toEqual(
          offsetMs === -1
            ? { outcome: "healthy", nextCheckMs: cappedConfig.inactivity.minCheckIntervalMs }
            : { outcome: "inactivity_timeout" }
        );
      }
    }
  );
});

describe("resolveUnattendedInactivityTimeoutMs", () => {
  it.each([
    [undefined, 120_000],
    ["", 120_000],
    [String(MIN_UNATTENDED_INACTIVITY_TIMEOUT_MS), 60_000],
    ["60001", 60_001],
    ["120000", 120_000],
    ["600000", 600_000],
    ["900000", 900_000],
    [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
  ] as const)("accepts %j without a rejection", (raw, timeoutMs) => {
    expect(resolveUnattendedInactivityTimeoutMs(raw)).toEqual({ timeoutMs, rejectedValue: null });
  });

  it.each([
    "0",
    "-1",
    "59999",
    "60000.5",
    "60000ms",
    "6e4",
    "0xea60",
    "NaN",
    "Infinity",
    " 60000",
    "60000 ",
    " ",
    "9007199254740992",
  ])("rejects %j to the default without losing the rejected value", (raw) => {
    expect(resolveUnattendedInactivityTimeoutMs(raw)).toEqual({
      timeoutMs: 120_000,
      rejectedValue: raw,
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
