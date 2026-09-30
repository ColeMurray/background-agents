import { afterEach, describe, expect, it, vi } from "vitest";
import {
  attemptRejectedStartupCleanup,
  destroyLateProviderResult,
  rearmRejectedStartupCleanupAlarm,
  type AllocationCleanupDependencies,
} from "./allocation-cleanup";
import { createMockSandbox } from "./test-helpers";

function fixture() {
  const row = createMockSandbox({
    status: "failed",
    fenced: 1,
    startup_rejected: 1,
    modal_object_id: "rejected-handle",
  });
  const generation = { sandboxId: row.modal_sandbox_id, createdAt: row.created_at };
  const logger = { warn: vi.fn() };
  const deps = {
    storage: {
      getSandbox: vi.fn(() => row),
      updateSandboxModalObjectId: vi.fn((handle: string | null) => {
        row.modal_object_id = handle;
      }),
    },
    alarmScheduler: { schedule: vi.fn(async (_deadline: number) => {}) },
    canStop: vi.fn(() => true),
    stop: vi.fn(async (_handle: string, _signal: AbortSignal) => {}),
    getLogger: vi.fn(() => logger),
  } satisfies AllocationCleanupDependencies;
  return { row, generation, deps, logger };
}

afterEach(() => vi.useRealTimers());

describe("allocation cleanup mechanics", () => {
  it.each([
    [1, "rejected-handle", true],
    [0, "rejected-handle", false],
    [1, null, false],
  ] as const)(
    "rearms only a rejected row with a handle (%s, %s)",
    async (rejected, handle, armed) => {
      vi.useFakeTimers();
      const { row, deps } = fixture();
      row.startup_rejected = rejected;
      row.modal_object_id = handle;
      await rearmRejectedStartupCleanupAlarm(deps);
      expect(deps.alarmScheduler.schedule.mock.calls).toEqual(armed ? [[Date.now() + 30_000]] : []);
      expect(deps.stop).not.toHaveBeenCalled();
    }
  );

  it("awaits retry persistence before stopping the explicit target, without retargeting", async () => {
    const { row, generation, deps } = fixture();
    let scheduled!: () => void;
    deps.alarmScheduler.schedule.mockImplementation(
      () => new Promise<void>((resolve) => (scheduled = resolve))
    );
    const cleaning = attemptRejectedStartupCleanup(deps, generation, "rejected-handle");
    expect(deps.stop).not.toHaveBeenCalled();
    row.modal_object_id = "replacement-handle";
    const replacement = structuredClone(row);
    scheduled();
    await cleaning;
    expect(deps.stop).toHaveBeenCalledExactlyOnceWith("rejected-handle", expect.any(AbortSignal));
    expect(row).toEqual(replacement);
    expect(deps.storage.updateSandboxModalObjectId).not.toHaveBeenCalled();
  });

  it.each([new Error("provider unavailable"), "provider unavailable"])(
    "retains the handle and retry after stop failure (%s)",
    async (error) => {
      vi.useFakeTimers();
      const { row, generation, deps, logger } = fixture();
      deps.stop.mockRejectedValue(error);
      await attemptRejectedStartupCleanup(deps, generation, "rejected-handle");
      expect(row.modal_object_id).toBe("rejected-handle");
      expect(deps.storage.updateSandboxModalObjectId).not.toHaveBeenCalled();
      expect(deps.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(Date.now() + 30_000);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        "Failed to destroy superseded provider sandbox",
        { provider_object_id: "rejected-handle", error: "provider unavailable" }
      );
      expect(vi.getTimerCount()).toBe(0);
    }
  );

  it("bounds local stop without treating abort or later success as retirement", async () => {
    vi.useFakeTimers();
    const { row, generation, deps, logger } = fixture();
    const startedAt = Date.now();
    let finishStop!: () => void;
    const stopping = new Promise<void>((resolve) => (finishStop = resolve));
    deps.stop.mockImplementation(() => stopping);
    const cleaning = attemptRejectedStartupCleanup(deps, generation, "rejected-handle");
    await vi.advanceTimersByTimeAsync(9_999);
    const signal = deps.stop.mock.calls[0][1];
    expect(signal.aborted).toBe(false);
    expect(row.modal_object_id).toBe("rejected-handle");
    await vi.advanceTimersByTimeAsync(1);
    await cleaning;
    expect(signal.aborted).toBe(true);
    expect(deps.alarmScheduler.schedule).toHaveBeenCalledExactlyOnceWith(startedAt + 30_000);
    expect(logger.warn).toHaveBeenCalledWith("Failed to destroy superseded provider sandbox", {
      provider_object_id: "rejected-handle",
      error: "Late provider cleanup timed out",
    });
    finishStop();
    await stopping;
    expect(row.modal_object_id).toBe("rejected-handle");
    expect(deps.storage.updateSandboxModalObjectId).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears only the matching handle after confirmed retirement", async () => {
    const { row, generation, deps } = fixture();
    const before = structuredClone(row);
    await attemptRejectedStartupCleanup(deps, generation, "rejected-handle");
    expect(deps.storage.updateSandboxModalObjectId).toHaveBeenCalledExactlyOnceWith(null);
    expect(row).toEqual({ ...before, modal_object_id: null });
    deps.alarmScheduler.schedule.mockClear();
    await rearmRejectedStartupCleanupAlarm(deps);
    expect(deps.alarmScheduler.schedule).not.toHaveBeenCalled();
  });

  it.each([undefined, "rejected-handle"])(
    "does not stop an absent handle or unsupported provider (%s)",
    async (handle) => {
      const { deps } = fixture();
      deps.canStop.mockReturnValue(handle === undefined);
      expect(await destroyLateProviderResult(deps, handle)).toBe(false);
      expect(deps.stop).not.toHaveBeenCalled();
      expect(deps.getLogger).not.toHaveBeenCalled();
    }
  );
});
