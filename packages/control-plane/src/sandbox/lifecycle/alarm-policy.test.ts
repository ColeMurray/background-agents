import { describe, expect, it } from "vitest";
import {
  evaluateAlarmPolicy,
  type AlarmFinding,
  type AlarmPolicyConfig,
  type AlarmSandbox,
} from "./alarm-policy";

const now = 10_000_000;
const config: AlarmPolicyConfig = {
  connectingTimeout: { timeoutMs: 120_000 },
  heartbeat: { timeoutMs: 90_000 },
  bootBudget: { timeoutMs: 1_800_000 },
  inactivity: { timeoutMs: 600_000, extensionMs: 300_000, minCheckIntervalMs: 30_000 },
};

function row(overrides: Partial<AlarmSandbox> = {}): AlarmSandbox {
  return {
    status: "connecting",
    created_at: now - 60_000,
    last_heartbeat: null,
    last_activity: null,
    ...overrides,
  };
}

const healthy = { outcome: "healthy", nextCheckMs: config.inactivity.minCheckIntervalMs } as const;

describe("evaluateAlarmPolicy", () => {
  it("prioritizes terminal, connect watchdog, stale heartbeat, boot budget, then inactivity", () => {
    const expired = row({
      created_at: now - config.bootBudget.timeoutMs,
      last_activity: now - config.inactivity.timeoutMs,
    });

    expect(evaluateAlarmPolicy({ ...expired, status: "failed" }, config, now, 0)).toEqual({
      outcome: "terminal",
    });
    expect(evaluateAlarmPolicy(expired, config, now, 0).outcome).toBe("connecting_timeout");
    expect(
      evaluateAlarmPolicy(
        { ...expired, last_heartbeat: now - config.heartbeat.timeoutMs - 1 },
        config,
        now,
        0
      ).outcome
    ).toBe("heartbeat_stale");
    expect(evaluateAlarmPolicy({ ...expired, last_heartbeat: now }, config, now, 0).outcome).toBe(
      "boot_budget_exceeded"
    );
    expect(
      evaluateAlarmPolicy({ ...expired, status: "ready", last_heartbeat: now }, config, now, 0)
    ).toEqual({ outcome: "inactivity_timeout" });
    // A ready sandbox with both deadlines expired still takes the heartbeat exit.
    expect(
      evaluateAlarmPolicy({ ...expired, status: "ready", last_heartbeat: 0 }, config, now, 0)
        .outcome
    ).toBe("heartbeat_stale");
  });

  it.each(["stopped", "stale", "failed"] as const)(
    "ignores a %s row even with stale timestamps",
    (status) => {
      expect(
        evaluateAlarmPolicy(
          row({ status, created_at: 0, last_heartbeat: 0, last_activity: 0 }),
          config,
          now,
          0
        )
      ).toEqual({ outcome: "terminal" });
    }
  );

  describe.each(["spawning", "connecting"] as const)("%s", (status) => {
    it.each([-1, 0, 1])("checks the connect watchdog at its boundary (%i ms)", (offsetMs) => {
      const elapsedMs = config.connectingTimeout.timeoutMs + offsetMs;
      expect(
        evaluateAlarmPolicy(row({ status, created_at: now - elapsedMs }), config, now, 0)
      ).toEqual(offsetMs < 0 ? healthy : { outcome: "connecting_timeout", elapsedMs });
    });

    it("stands down the watchdog once a heartbeat proves connection", () => {
      expect(
        evaluateAlarmPolicy(
          row({ status, created_at: now - 500_000, last_heartbeat: now }),
          config,
          now,
          0
        )
      ).toEqual(healthy);
    });

    it("selects boot-failure recovery for a stale heartbeat", () => {
      expect(
        evaluateAlarmPolicy(
          row({ status, last_heartbeat: now - config.heartbeat.timeoutMs - 1 }),
          config,
          now,
          0
        )
      ).toEqual({
        outcome: "heartbeat_stale",
        ageMs: 90_001,
        isBooting: true,
      });
    });

    it.each([-1, 0, 1])("checks the boot budget at its boundary (%i ms)", (offsetMs) => {
      const elapsedMs = config.bootBudget.timeoutMs + offsetMs;
      const finding = evaluateAlarmPolicy(
        row({ status, created_at: now - elapsedMs, last_heartbeat: now }),
        config,
        now,
        10
      );
      expect(finding).toEqual(
        offsetMs < 0 ? healthy : { outcome: "boot_budget_exceeded", elapsedMs }
      );
    });

    it("does not treat a boot as idle, even with old activity and no clients", () => {
      expect(evaluateAlarmPolicy(row({ status, last_activity: 0 }), config, now, 0)).toEqual(
        healthy
      );
    });
  });

  it.each(["pending", "ready", "snapshotting"] as const)(
    "does not impose a boot budget on %s",
    (status) => {
      expect(
        evaluateAlarmPolicy(row({ status, created_at: 0, last_heartbeat: now }), config, now, 0)
      ).toEqual(healthy);
    }
  );

  it.each([-1, 0, 1])(
    "marks heartbeats stale only strictly past the threshold (%i ms)",
    (offsetMs) => {
      const ageMs = config.heartbeat.timeoutMs + offsetMs;
      expect(
        evaluateAlarmPolicy(row({ status: "ready", last_heartbeat: now - ageMs }), config, now, 0)
      ).toEqual(
        offsetMs <= 0
          ? healthy
          : {
              outcome: "heartbeat_stale",
              ageMs,
              isBooting: false,
            }
      );
    }
  );

  it("treats a heartbeat timestamp of zero as a connection, not an absent heartbeat", () => {
    expect(
      evaluateAlarmPolicy(row({ created_at: 0, last_heartbeat: 0 }), config, now, 0).outcome
    ).toBe("heartbeat_stale");
  });

  it.each<[number | null, number, AlarmFinding]>([
    [null, 0, healthy],
    [now - 300_000, 0, { outcome: "healthy", nextCheckMs: 300_000 }],
    [now - 599_999, 0, healthy],
    [now - 600_000, 0, { outcome: "inactivity_timeout" }],
    [now - 600_001, 0, { outcome: "inactivity_timeout" }],
    [now - 600_000, 2, { outcome: "inactivity_warning", extensionMs: 300_000 }],
    [now - 600_000, 1, { outcome: "inactivity_warning", extensionMs: 300_000 }],
    [now - 599_999, 1, healthy],
    [0, 0, { outcome: "inactivity_timeout" }],
  ])("evaluates inactivity with activity %s and %i clients", (last_activity, clients, expected) => {
    expect(
      evaluateAlarmPolicy(
        row({
          status: "ready",
          last_heartbeat: now,
          last_activity,
        }),
        config,
        now,
        clients
      )
    ).toEqual(expected);
  });

  it.each(["pending", "snapshotting"] as const)("does not stop an idle %s row", (status) => {
    expect(
      evaluateAlarmPolicy(row({ status, last_heartbeat: now, last_activity: 0 }), config, now, 0)
    ).toEqual(healthy);
  });

  it("still checks inactivity without a heartbeat on a ready row", () => {
    expect(evaluateAlarmPolicy(row({ status: "ready", last_activity: 0 }), config, now, 0)).toEqual(
      {
        outcome: "inactivity_timeout",
      }
    );
  });

  it("honors custom heartbeat, boot budget and inactivity settings", () => {
    const custom = {
      ...config,
      bootBudget: { timeoutMs: 250_000 },
      heartbeat: { timeoutMs: 50 },
      inactivity: { timeoutMs: 100, extensionMs: 80, minCheckIntervalMs: 10 },
    };
    expect(
      evaluateAlarmPolicy(row({ status: "ready", last_heartbeat: now - 51 }), custom, now, 0)
    ).toEqual({ outcome: "heartbeat_stale", ageMs: 51, isBooting: false });
    expect(
      evaluateAlarmPolicy(row({ created_at: now - 250_000, last_heartbeat: now }), custom, now, 0)
    ).toEqual({ outcome: "boot_budget_exceeded", elapsedMs: 250_000 });
    const idle = row({ status: "ready", last_heartbeat: now, last_activity: now - 100 });
    expect(evaluateAlarmPolicy(idle, custom, now, 1)).toEqual({
      outcome: "inactivity_warning",
      extensionMs: 80,
    });
    expect(evaluateAlarmPolicy({ ...idle, last_activity: now - 99 }, custom, now, 0)).toEqual({
      outcome: "healthy",
      nextCheckMs: 10,
    });
  });
});
