/**
 * Unit tests for sandbox lifecycle decision functions.
 *
 * These are pure functions with no side effects, making them easy to test.
 */

import { describe, it, expect } from "vitest";
import { MIN_COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/model";
import {
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
  evaluateInactivityTimeout,
  evaluateHeartbeatHealth,
  evaluateProviderOperationLease,
  evaluateRuntimeAttachTimeout,
  evaluateWarmDecision,
  evaluateExecutionTimeout,
  isSandboxReconnectBlockedStatus,
  isSnapshotRuntimeCompatible,
  DEFAULT_PROVIDER_OPERATION_LEASE_CONFIG,
  DEFAULT_RUNTIME_ATTACH_TIMEOUT_CONFIG,
  DEFAULT_EXECUTION_TIMEOUT_MS,
  DEFAULT_LEGACY_STARTUP_CAP_MS,
  type CircuitBreakerState,
  type CircuitBreakerConfig,
  type SandboxState,
  type SpawnConfig,
  type InactivityState,
  type InactivityConfig,
  type HeartbeatConfig,
  type ProviderOperationLeaseConfig,
  type RuntimeAttachTimeoutConfig,
  type WarmState,
  type ExecutionTimeoutConfig,
} from "./decisions";

describe("isSandboxReconnectBlockedStatus", () => {
  it.each(["stopped", "stale"] as const)("blocks reconnects for %s sandboxes", (status) => {
    expect(isSandboxReconnectBlockedStatus(status)).toBe(true);
  });

  it.each(["pending", "spawning", "connecting", "ready", "failed"] as const)(
    "allows reconnects for %s sandboxes",
    (status) => {
      expect(isSandboxReconnectBlockedStatus(status)).toBe(false);
    }
  );
});

// ==================== Circuit Breaker Tests ====================

describe("evaluateCircuitBreaker", () => {
  const config: CircuitBreakerConfig = {
    threshold: 3,
    windowMs: 5 * 60 * 1000, // 5 minutes
  };

  it("allows spawn when no failures", () => {
    const state: CircuitBreakerState = {
      failureCount: 0,
      lastFailureTime: 0,
    };
    const now = Date.now();

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(true);
    expect(decision.shouldReset).toBe(false);
    expect(decision.waitTimeMs).toBeUndefined();
  });

  it("allows spawn when failures below threshold", () => {
    const now = Date.now();
    const state: CircuitBreakerState = {
      failureCount: 2,
      lastFailureTime: now - 60000, // 1 minute ago
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(true);
    expect(decision.shouldReset).toBe(false);
  });

  it("blocks spawn after threshold failures within window", () => {
    const now = Date.now();
    const state: CircuitBreakerState = {
      failureCount: 3,
      lastFailureTime: now - 60000, // 1 minute ago
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(false);
    expect(decision.shouldReset).toBe(false);
    expect(decision.waitTimeMs).toBe(config.windowMs - 60000);
  });

  it("returns correct wait time when blocked", () => {
    const now = Date.now();
    const timeSinceFailure = 120000; // 2 minutes
    const state: CircuitBreakerState = {
      failureCount: 5,
      lastFailureTime: now - timeSinceFailure,
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(false);
    expect(decision.waitTimeMs).toBe(config.windowMs - timeSinceFailure);
  });

  it("signals reset when window passes", () => {
    const now = Date.now();
    const state: CircuitBreakerState = {
      failureCount: 5,
      lastFailureTime: now - config.windowMs - 1000, // Window passed
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    expect(decision.shouldProceed).toBe(true);
    expect(decision.shouldReset).toBe(true);
  });

  it("handles boundary timing (exact window)", () => {
    const now = Date.now();
    const state: CircuitBreakerState = {
      failureCount: 3,
      lastFailureTime: now - config.windowMs, // Exactly at window boundary
    };

    const decision = evaluateCircuitBreaker(state, config, now);

    // At exact boundary, should reset
    expect(decision.shouldProceed).toBe(true);
    expect(decision.shouldReset).toBe(true);
  });
});

// ==================== Spawn Decision Tests ====================

describe("evaluateSpawnDecision", () => {
  const config: SpawnConfig = {
    cooldownMs: 30000,
    readyWaitMs: 60000,
    providerOperationLeaseMs: 120000,
    runtimeAttachTimeoutMs: 120000,
    legacyStartupCapMs: DEFAULT_LEGACY_STARTUP_CAP_MS,
  };

  it('returns "restore" when snapshot exists and sandbox is stopped', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: "v99-test",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("restore");
    if (decision.action === "restore") {
      expect(decision.snapshotImageId).toBe("img-abc123");
    }
  });

  it('returns "restore" when snapshot exists and sandbox is stale', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stale",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: "v99-test",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("restore");
  });

  it('returns "restore" when snapshot exists and sandbox is failed', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "failed",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: "v99-test",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("restore");
  });

  it("spawns fresh instead of restoring a snapshot below the runtime floor", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: `v${MIN_COMPATIBLE_RUNTIME_VERSION - 1}-retired`,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
    if (decision.action === "spawn") {
      expect(decision.reason).toContain(`v${MIN_COMPATIBLE_RUNTIME_VERSION - 1}-retired`);
    }
  });

  it("spawns fresh when the snapshot predates runtime-version recording", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
    if (decision.action === "spawn") {
      expect(decision.reason).toContain("unknown");
    }
  });

  it("restores a snapshot taken exactly at the runtime floor", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: `v${MIN_COMPATIBLE_RUNTIME_VERSION}-at-floor`,
      hasActiveWebSocket: false,
    };

    expect(evaluateSpawnDecision(state, config, now, false).action).toBe("restore");
  });

  it("keeps the in-memory spawn guard ahead of the runtime floor check", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    // A rejected snapshot must not let a concurrent evaluation start a second
    // spawn while the first is still in flight.
    expect(evaluateSpawnDecision(state, config, now, true).action).toBe("skip");
  });

  it('returns "skip" when already spawning', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "spawning",
      createdAt: now - 5000,
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("spawning");
    }
  });

  it('returns "skip" when connecting', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "connecting",
      createdAt: now - 5000,
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("skip");
  });

  it('returns "spawn" when stuck in "spawning" past the spawning timeout (recovers interrupted spawn)', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "spawning",
      createdAt: now - (config.providerOperationLeaseMs + 1000),
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it('returns "spawn" when stuck in "connecting" past the spawning timeout', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "connecting",
      createdAt: now - 60_000,
      runtimeAttachStartedAt: now - (config.runtimeAttachTimeoutMs + 1000),
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it("never replaces a booting sandbox based on total boot duration", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "booting",
      createdAt: now - 24 * 60 * 60 * 1000,
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    expect(evaluateSpawnDecision(state, config, now, false)).toEqual({
      action: "skip",
      reason: "already booting",
    });
  });

  it('extends a legacy "connecting" lease with progress but enforces the absolute cap', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "connecting",
      createdAt: now - config.runtimeAttachTimeoutMs - 1,
      runtimeAttachStartedAt: now - config.runtimeAttachTimeoutMs - 1,
      bootProgressAt: now - 1,
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    expect(evaluateSpawnDecision(state, config, now, false).action).toBe("skip");
    state.runtimeAttachStartedAt = now - config.legacyStartupCapMs;
    expect(evaluateSpawnDecision(state, config, now, false).action).toBe("spawn");
  });

  it('still skips a stale "spawning" when a spawn is in progress in-memory', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "spawning",
      createdAt: now - (config.providerOperationLeaseMs + 1000),
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, true);

    expect(decision.action).toBe("skip");
  });

  it('returns "skip" when ready with active WebSocket', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "ready",
      createdAt: now - 120000,
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: true,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("active WebSocket");
    }
  });

  it('returns "wait" when ready without WebSocket but recent spawn', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "ready",
      createdAt: now - 30000, // 30 seconds ago, less than readyWaitMs
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("wait");
    if (decision.action === "wait") {
      expect(decision.reason).toContain("no WebSocket");
    }
  });

  it('returns "wait" during cooldown period', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "pending",
      createdAt: now - 10000, // 10 seconds ago, less than cooldownMs
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("wait");
    if (decision.action === "wait") {
      expect(decision.reason).toContain("waiting");
    }
  });

  it('returns "skip" when isSpawningInMemory flag is set', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "pending",
      createdAt: now - 60000,
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, true);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("in-memory flag");
    }
  });

  it("skips restore when a spawn is already in progress in-memory", () => {
    // A restore sets the in-memory flag synchronously but persists the
    // "spawning" status only after its first await; a concurrent evaluation in
    // that window still sees "stopped" and must not start a second restore.
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: "v99-test",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, true);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("in-memory flag");
    }
  });

  it("skips resume when a spawn is already in progress in-memory", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      providerObjectId: "sb-123",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, true, true);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("in-memory flag");
    }
  });

  it('returns "spawn" when all conditions pass', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "pending",
      createdAt: now - 60000, // Past cooldown
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it("failed status bypasses cooldown", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "failed",
      createdAt: now - 5000, // Within cooldown, but status is failed
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it("stopped status bypasses cooldown", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 5000, // Within cooldown, but status is stopped
      snapshotImageId: null, // No snapshot, so fresh spawn
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  // ---- Persistent resume (Daytona-style) ----

  it('returns "resume" when provider supports persistent resume and sandbox is stopped with providerObjectId', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("resume");
    if (decision.action === "resume") {
      expect(decision.providerObjectId).toBe("daytona-abc123");
    }
  });

  it('returns "resume" when provider supports persistent resume and sandbox is stale with providerObjectId', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stale",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("resume");
  });

  it("resume takes priority over restore when both available", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: "v99-test",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("resume");
  });

  it('falls back to "restore" when supportsPersistentResume but no providerObjectId', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: null,
      snapshotImageId: "img-abc123",
      snapshotRuntimeVersion: "v99-test",
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("restore");
  });

  it('falls back to "spawn" when supportsPersistentResume but no providerObjectId and no snapshot', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: null,
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    expect(decision.action).toBe("spawn");
  });

  it("does not resume when supportsPersistentResume is false even with providerObjectId", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, false);

    expect(decision.action).toBe("spawn");
  });

  it("does not resume for failed status even with providerObjectId", () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "failed",
      createdAt: now - 120000,
      providerObjectId: "daytona-abc123",
      snapshotImageId: null,
      snapshotRuntimeVersion: null,
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false, true);

    // "failed" is not a resume-eligible status — should fall through to spawn
    expect(decision.action).toBe("spawn");
  });
});

// ==================== Inactivity Timeout Tests ====================

describe("evaluateInactivityTimeout", () => {
  const config: InactivityConfig = {
    timeoutMs: 10 * 60 * 1000, // 10 minutes
    extensionMs: 5 * 60 * 1000, // 5 minutes
    minCheckIntervalMs: 30000, // 30 seconds
  };

  it('returns "schedule" for terminal states (stopped)', () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: now - config.timeoutMs - 60000, // Well past timeout
      status: "stopped",
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
    if (decision.action === "schedule") {
      expect(decision.nextCheckMs).toBe(config.minCheckIntervalMs);
    }
  });

  it('returns "schedule" for terminal states (failed)', () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: now - config.timeoutMs - 60000,
      status: "failed",
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
  });

  it('returns "schedule" for terminal states (stale)', () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: now - config.timeoutMs - 60000,
      status: "stale",
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
  });

  it('returns "schedule" when no lastActivity', () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: null,
      status: "ready",
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
    if (decision.action === "schedule") {
      expect(decision.nextCheckMs).toBe(config.minCheckIntervalMs);
    }
  });

  it('returns "timeout" when inactivity exceeds threshold with no clients', () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: now - config.timeoutMs - 1000, // Just past timeout
      status: "ready",
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("timeout");
    if (decision.action === "timeout") {
      expect(decision.shouldSnapshot).toBe(true);
    }
  });

  it('returns "extend" when threshold exceeded but clients connected', () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: now - config.timeoutMs - 1000,
      status: "ready",
      connectedClientCount: 2,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("extend");
    if (decision.action === "extend") {
      expect(decision.extensionMs).toBe(config.extensionMs);
      expect(decision.shouldWarn).toBe(true);
    }
  });

  it('returns "schedule" with correct remaining time', () => {
    const now = Date.now();
    const inactiveTime = 5 * 60 * 1000; // 5 minutes
    const state: InactivityState = {
      lastActivity: now - inactiveTime,
      status: "ready",
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
    if (decision.action === "schedule") {
      expect(decision.nextCheckMs).toBe(config.timeoutMs - inactiveTime);
    }
  });

  it("handles minimum check interval", () => {
    const now = Date.now();
    // 9 minutes 50 seconds - very close to timeout
    const inactiveTime = config.timeoutMs - 10000;
    const state: InactivityState = {
      lastActivity: now - inactiveTime,
      status: "ready",
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
    if (decision.action === "schedule") {
      // Should be max of remaining time (10s) and min interval (30s)
      expect(decision.nextCheckMs).toBe(config.minCheckIntervalMs);
    }
  });

  it("only applies to ready status", () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: now - config.timeoutMs - 60000,
      status: "spawning", // Not ready
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
  });

  it('returns "timeout" for ready status', () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: now - config.timeoutMs - 1000,
      status: "ready",
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("timeout");
  });
});

// ==================== Heartbeat Health Tests ====================

describe("evaluateHeartbeatHealth", () => {
  const config: HeartbeatConfig = {
    timeoutMs: 90000, // 90 seconds
  };

  it("returns not stale when no heartbeat recorded", () => {
    const now = Date.now();

    const health = evaluateHeartbeatHealth(null, config, now);

    expect(health.isStale).toBe(false);
    expect(health.ageMs).toBeUndefined();
  });

  it("returns not stale when heartbeat is recent", () => {
    const now = Date.now();
    const lastHeartbeat = now - 30000; // 30 seconds ago

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    expect(health.isStale).toBe(false);
    expect(health.ageMs).toBeUndefined();
  });

  it("returns stale when heartbeat exceeds timeout", () => {
    const now = Date.now();
    const lastHeartbeat = now - 100000; // 100 seconds ago (> 90s timeout)

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    expect(health.isStale).toBe(true);
    expect(health.ageMs).toBe(100000);
  });

  it("returns correct age in milliseconds", () => {
    const now = Date.now();
    const ageMs = 150000;
    const lastHeartbeat = now - ageMs;

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    expect(health.isStale).toBe(true);
    expect(health.ageMs).toBe(ageMs);
  });

  it("handles boundary timing (exactly at timeout)", () => {
    const now = Date.now();
    const lastHeartbeat = now - config.timeoutMs; // Exactly at timeout

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    // At exact boundary, not stale (> vs >=)
    expect(health.isStale).toBe(false);
  });

  it("handles boundary timing (just past timeout)", () => {
    const now = Date.now();
    const lastHeartbeat = now - config.timeoutMs - 1; // Just past timeout

    const health = evaluateHeartbeatHealth(lastHeartbeat, config, now);

    expect(health.isStale).toBe(true);
    expect(health.ageMs).toBe(config.timeoutMs + 1);
  });
});

// ==================== Startup Timing Tests ====================

describe("evaluateProviderOperationLease", () => {
  const config: ProviderOperationLeaseConfig = DEFAULT_PROVIDER_OPERATION_LEASE_CONFIG;

  it("allows a provider operation to exceed the runtime attach timeout", () => {
    const now = Date.now();
    const startedAt = now - DEFAULT_RUNTIME_ATTACH_TIMEOUT_CONFIG.timeoutMs - 1;

    expect(evaluateProviderOperationLease("spawning", startedAt, null, config, now)).toEqual({
      isTimedOut: false,
      elapsedMs: DEFAULT_RUNTIME_ATTACH_TIMEOUT_CONFIG.timeoutMs + 1,
      livenessAt: startedAt,
      deadlineAt: startedAt + config.timeoutMs,
    });
  });

  it("expires from the reservation timestamp and ignores legacy progress", () => {
    const now = Date.now();
    const startedAt = now - config.timeoutMs;

    expect(
      evaluateProviderOperationLease("connecting", startedAt, null, config, now).isTimedOut
    ).toBe(true);
  });

  it("stops applying once runtime attachment timing starts", () => {
    const now = Date.now();
    expect(
      evaluateProviderOperationLease("connecting", now - config.timeoutMs, now, config, now)
        .isTimedOut
    ).toBe(false);
  });
});

describe("evaluateRuntimeAttachTimeout", () => {
  const config: RuntimeAttachTimeoutConfig = DEFAULT_RUNTIME_ATTACH_TIMEOUT_CONFIG;

  it("starts a fresh attach window after a long provider operation", () => {
    const now = Date.now();
    const attachStartedAt = now - 1_000;

    expect(evaluateRuntimeAttachTimeout("connecting", attachStartedAt, config, now)).toEqual({
      isTimedOut: false,
      elapsedMs: 1_000,
      livenessAt: attachStartedAt,
      deadlineAt: attachStartedAt + config.timeoutMs,
    });
  });

  it("extends legacy attach liveness without exceeding the attach cap", () => {
    const now = Date.now();
    const attachStartedAt = now - 300_000;
    const recentProgress = now - 1_000;

    expect(
      evaluateRuntimeAttachTimeout("connecting", attachStartedAt, config, now, recentProgress)
    ).toEqual({
      isTimedOut: false,
      elapsedMs: 1_000,
      livenessAt: recentProgress,
      deadlineAt: recentProgress + config.timeoutMs,
    });

    const cappedStart = now - config.legacyStartupCapMs;
    const capped = evaluateRuntimeAttachTimeout("connecting", cappedStart, config, now, now);
    expect(capped.isTimedOut).toBe(true);
    expect(capped.elapsedMs).toBe(config.legacyStartupCapMs);
  });

  it.each(["booting", "ready", "snapshotting"] as const)(
    "never applies total duration to attached %s",
    (status) => {
      const now = Date.now();
      expect(
        evaluateRuntimeAttachTimeout(status, now - config.legacyStartupCapMs * 2, config, now, now)
          .isTimedOut
      ).toBe(false);
    }
  );
});

// ==================== Warm Decision Tests ====================

describe("evaluateWarmDecision", () => {
  it('returns "skip" when sandbox already connected', () => {
    const state: WarmState = {
      hasActiveWebSocket: true,
      status: "ready",
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("already connected");
    }
  });

  it('returns "skip" when already spawning (in-memory)', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: "pending",
      isSpawningInMemory: true,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("already spawning");
    }
  });

  it('returns "skip" when sandbox status is spawning', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: "spawning",
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("spawning");
    }
  });

  it('returns "skip" when sandbox status is connecting', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: "connecting",
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("skip");
    if (decision.action === "skip") {
      expect(decision.reason).toContain("connecting");
    }
  });

  it('returns "skip" when sandbox status is booting without a socket', () => {
    const decision = evaluateWarmDecision({
      hasActiveWebSocket: false,
      status: "booting",
      isSpawningInMemory: false,
    });

    expect(decision).toEqual({ action: "skip", reason: "sandbox status is booting" });
  });

  it('returns "spawn" when conditions pass', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: "pending",
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("spawn");
  });

  it('returns "spawn" when status is null', () => {
    const state: WarmState = {
      hasActiveWebSocket: false,
      status: null,
      isSpawningInMemory: false,
    };

    const decision = evaluateWarmDecision(state);

    expect(decision.action).toBe("spawn");
  });
});

// ==================== Execution Timeout Tests ====================

describe("evaluateExecutionTimeout", () => {
  const config: ExecutionTimeoutConfig = {
    timeoutMs: DEFAULT_EXECUTION_TIMEOUT_MS, // 90 minutes
  };

  it("returns not timed out within threshold", () => {
    const now = Date.now();
    const startedAt = now - 60000; // 1 minute ago

    const result = evaluateExecutionTimeout(startedAt, config, now);

    expect(result.isTimedOut).toBe(false);
    expect(result.elapsedMs).toBe(60000);
  });

  it("returns timed out past threshold", () => {
    const now = Date.now();
    const startedAt = now - DEFAULT_EXECUTION_TIMEOUT_MS - 1000; // Just past 90 minutes

    const result = evaluateExecutionTimeout(startedAt, config, now);

    expect(result.isTimedOut).toBe(true);
    expect(result.elapsedMs).toBe(DEFAULT_EXECUTION_TIMEOUT_MS + 1000);
  });

  it("returns timed out at exact threshold", () => {
    const now = Date.now();
    const startedAt = now - DEFAULT_EXECUTION_TIMEOUT_MS;

    const result = evaluateExecutionTimeout(startedAt, config, now);

    expect(result.isTimedOut).toBe(true);
    expect(result.elapsedMs).toBe(DEFAULT_EXECUTION_TIMEOUT_MS);
  });

  it("works with custom timeout config", () => {
    const customConfig: ExecutionTimeoutConfig = { timeoutMs: 5000 };
    const now = Date.now();
    const startedAt = now - 6000;

    const result = evaluateExecutionTimeout(startedAt, customConfig, now);

    expect(result.isTimedOut).toBe(true);
    expect(result.elapsedMs).toBe(6000);
  });
});

// ==================== Snapshot Runtime Floor ====================

describe("isSnapshotRuntimeCompatible", () => {
  it("accepts a snapshot at or above the floor", () => {
    expect(isSnapshotRuntimeCompatible(`v${MIN_COMPATIBLE_RUNTIME_VERSION}-x`)).toBe(true);
    expect(isSnapshotRuntimeCompatible(`v${MIN_COMPATIBLE_RUNTIME_VERSION + 1}-x`)).toBe(true);
  });

  it("rejects a snapshot below the floor", () => {
    expect(isSnapshotRuntimeCompatible(`v${MIN_COMPATIBLE_RUNTIME_VERSION - 1}-x`)).toBe(false);
  });

  it("fails closed on missing or unparseable versions", () => {
    expect(isSnapshotRuntimeCompatible(null)).toBe(false);
    expect(isSnapshotRuntimeCompatible("")).toBe(false);
    expect(isSnapshotRuntimeCompatible("daytona-v6-vnc")).toBe(false);
  });
});
