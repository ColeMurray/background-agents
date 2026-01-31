/**
 * Unit tests for sandbox lifecycle decision functions.
 *
 * These are pure functions with no side effects, making them easy to test.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
  evaluateInactivityTimeout,
  evaluateHeartbeatHealth,
  evaluateWarmDecision,
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  DEFAULT_INACTIVITY_CONFIG,
  DEFAULT_HEARTBEAT_CONFIG,
  type CircuitBreakerState,
  type CircuitBreakerConfig,
  type SandboxState,
  type SpawnConfig,
  type InactivityState,
  type InactivityConfig,
  type HeartbeatConfig,
  type WarmState,
} from "./decisions";

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

  it("uses default config values correctly", () => {
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.threshold).toBe(3);
    expect(DEFAULT_CIRCUIT_BREAKER_CONFIG.windowMs).toBe(5 * 60 * 1000);
  });
});

// ==================== Spawn Decision Tests ====================

describe("evaluateSpawnDecision", () => {
  const config: SpawnConfig = {
    cooldownMs: 30000,
    readyWaitMs: 60000,
  };

  it('returns "restore" when snapshot exists and sandbox is stopped', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "stopped",
      createdAt: now - 120000,
      snapshotImageId: "img-abc123",
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
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("restore");
  });

  it('returns "skip" when already spawning', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "spawning",
      createdAt: now - 5000,
      snapshotImageId: null,
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
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("skip");
  });

  it('returns "skip" when ready with active WebSocket', () => {
    const now = Date.now();
    const state: SandboxState = {
      status: "ready",
      createdAt: now - 120000,
      snapshotImageId: null,
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
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, true);

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
      hasActiveWebSocket: false,
    };

    const decision = evaluateSpawnDecision(state, config, now, false);

    expect(decision.action).toBe("spawn");
  });

  it("uses default config values correctly", () => {
    expect(DEFAULT_SPAWN_CONFIG.cooldownMs).toBe(30000);
    expect(DEFAULT_SPAWN_CONFIG.readyWaitMs).toBe(60000);
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

  it("only applies to ready/running status", () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: now - config.timeoutMs - 60000,
      status: "spawning", // Not ready or running
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("schedule");
  });

  it('returns "timeout" for running status', () => {
    const now = Date.now();
    const state: InactivityState = {
      lastActivity: now - config.timeoutMs - 1000,
      status: "running",
      connectedClientCount: 0,
    };

    const decision = evaluateInactivityTimeout(state, config, now);

    expect(decision.action).toBe("timeout");
  });

  it("uses default config values correctly", () => {
    expect(DEFAULT_INACTIVITY_CONFIG.timeoutMs).toBe(10 * 60 * 1000);
    expect(DEFAULT_INACTIVITY_CONFIG.extensionMs).toBe(5 * 60 * 1000);
    expect(DEFAULT_INACTIVITY_CONFIG.minCheckIntervalMs).toBe(30000);
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

  it("uses default config values correctly", () => {
    expect(DEFAULT_HEARTBEAT_CONFIG.timeoutMs).toBe(90000);
  });
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
