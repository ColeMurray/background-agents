import { describe, expect, it } from "vitest";
import {
  DEFAULT_CIRCUIT_BREAKER_CONFIG,
  DEFAULT_CONNECTING_TIMEOUT_CONFIG,
  DEFAULT_SPAWN_CONFIG,
  evaluateCircuitBreaker,
  evaluateSpawnDecision,
} from "./decisions";

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
