import { afterEach, describe, it, expect, vi } from "vitest";
import { DEFAULT_LIFECYCLE_CONFIG, type SandboxShutdownLifecycle } from "./manager";
import {
  createMockSession,
  createMockSandbox,
  createMockStorage,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createMockProvider,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
} from "./test-helpers";

describe("idle queue redrive", () => {
  afterEach(() => vi.restoreAllMocks());

  function redriveHarness(
    sandbox: Partial<Parameters<typeof createMockSandbox>[0]>,
    admission: ReturnType<SandboxShutdownLifecycle["admissionDecision"]> = "ready",
    inactivity = DEFAULT_LIFECYCLE_CONFIG.inactivity
  ) {
    const now = Date.now();
    const storage = createMockStorage(
      createMockSession(),
      createMockSandbox({ status: "ready", last_heartbeat: now, last_activity: now, ...sandbox })
    );
    const resumeQueuedWork = vi.fn(async () => undefined);
    const manager = createTestLifecycleManager(
      createMockProvider(),
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      {
        ...createUnmanagedShutdown(),
        admissionDecision: vi.fn<SandboxShutdownLifecycle["admissionDecision"]>(() => admission),
      },
      { ...createTestConfig(), inactivity, resumeQueuedWork }
    );
    return { manager, storage, resumeQueuedWork, now };
  }

  it("wakes queued work for a ready runtime the watchdog finds healthy", async () => {
    const { manager, resumeQueuedWork } = redriveHarness({});

    await manager.redriveIdleQueue();
    await manager.redriveIdleQueue();

    // Level-triggered: each pass may kick; the queue's claim makes repeats no-ops.
    expect(resumeQueuedWork).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["automation", 600_000, 120_000, 120_000],
    ["user", 600_000, 120_000, 600_000],
    [undefined, 600_000, 120_000, 600_000],
    ["automation", 600_000, 600_000, 600_000],
  ] as const)(
    "uses the session's cutoff for %s (regular=%i, unattended=%i, effective=%i)",
    async (source, timeoutMs, unattendedTimeoutMs, effectiveTimeoutMs) => {
      vi.spyOn(Date, "now").mockReturnValue(10_000_000);
      const { manager, storage, resumeQueuedWork, now } = redriveHarness({}, "ready", {
        ...DEFAULT_LIFECYCLE_CONFIG.inactivity,
        timeoutMs,
        unattendedTimeoutMs,
      });
      vi.mocked(storage.getSession).mockReturnValue(
        source ? createMockSession({ spawn_source: source }) : null
      );
      manager.updateLastActivity(now - effectiveTimeoutMs + 1);

      await manager.redriveIdleQueue();
      expect(resumeQueuedWork).toHaveBeenCalledOnce();

      manager.updateLastActivity(now - effectiveTimeoutMs);
      await manager.redriveIdleQueue();
      expect(resumeQueuedWork).toHaveBeenCalledOnce();
    }
  );

  it("rechecks the session source after the row appears or changes on the same manager", async () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000_000);
    const { manager, storage, resumeQueuedWork, now } = redriveHarness({});
    manager.updateLastActivity(now - 120_000);

    for (const [source, calls] of [
      [undefined, 1],
      ["automation", 1],
      ["user", 2],
    ] as const) {
      vi.mocked(storage.getSession).mockReturnValue(
        source ? createMockSession({ spawn_source: source }) : null
      );

      await manager.redriveIdleQueue();

      expect(resumeQueuedWork).toHaveBeenCalledTimes(calls);
    }
  });

  it.each([
    ["a stale heartbeat", { last_heartbeat: Date.now() - 10 * 60_000 }, "ready"],
    [
      "an inactivity stop that is already due",
      { last_activity: Date.now() - DEFAULT_LIFECYCLE_CONFIG.inactivity.timeoutMs - 1_000 },
      "ready",
    ],
    ["a booting runtime", { status: "connecting" as const }, "ready"],
    ["held admission", {}, "held"],
    ["admission that would start a sandbox", {}, "spawn_required"],
  ] as const)("does not wake queued work for %s", async (_name, sandbox, admission) => {
    const { manager, resumeQueuedWork } = redriveHarness(sandbox, admission);

    await manager.redriveIdleQueue();

    expect(resumeQueuedWork).not.toHaveBeenCalled();
  });
});
