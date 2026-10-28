import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createMockSession,
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

describe("inactivity scheduling", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads the current source on each call, even when the session row does not exist yet", async () => {
    const now = 10_000_000;
    vi.spyOn(Date, "now").mockReturnValue(now);
    const storage = createMockStorage(null);
    const alarmScheduler = createMockAlarmScheduler();
    const manager = createTestLifecycleManager(
      createMockProvider(),
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(),
      alarmScheduler,
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      createTestConfig()
    );

    for (const [source, timeoutMs] of [
      [undefined, 600_000],
      ["automation", 120_000],
      ["user", 600_000],
      ["github-bot", 120_000],
      ["linear-bot", 600_000],
      ["agent", 120_000],
      ["slack-bot", 600_000],
    ] as const) {
      vi.mocked(storage.getSession).mockReturnValue(
        source ? createMockSession({ spawn_source: source }) : null
      );

      await manager.scheduleInactivityCheck();

      expect(alarmScheduler.schedule).toHaveBeenLastCalledWith(now + timeoutMs);
    }
    expect(alarmScheduler.schedule).toHaveBeenCalledTimes(7);
  });
});
