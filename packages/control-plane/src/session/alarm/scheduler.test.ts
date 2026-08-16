import { describe, expect, it, vi } from "vitest";
import { createEarliestAlarmScheduler } from "./scheduler";

function createStorage(currentAlarm: number | null) {
  return {
    getAlarm: vi.fn(async () => currentAlarm),
    setAlarm: vi.fn(async (_timestamp: number) => {}),
  };
}

describe("createEarliestAlarmScheduler", () => {
  it("sets a deadline when no alarm exists", async () => {
    const storage = createStorage(null);
    const scheduler = createEarliestAlarmScheduler(storage);

    await scheduler.scheduleAlarm(2_000);

    expect(storage.setAlarm).toHaveBeenCalledWith(2_000);
  });

  it("replaces a later alarm", async () => {
    const storage = createStorage(3_000);
    const scheduler = createEarliestAlarmScheduler(storage);

    await scheduler.scheduleAlarm(2_000);

    expect(storage.setAlarm).toHaveBeenCalledWith(2_000);
  });

  it.each([1_000, 2_000])("preserves an existing alarm at %s", async (currentAlarm) => {
    const storage = createStorage(currentAlarm);
    const scheduler = createEarliestAlarmScheduler(storage);

    await scheduler.scheduleAlarm(2_000);

    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("serializes concurrent updates so a later deadline cannot replace an earlier one", async () => {
    let currentAlarm: number | null = null;
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    const storage = {
      getAlarm: vi
        .fn<() => Promise<number | null>>()
        .mockImplementationOnce(async () => {
          await firstRead;
          return currentAlarm;
        })
        .mockImplementation(async () => currentAlarm),
      setAlarm: vi.fn(async (timestamp: number) => {
        currentAlarm = timestamp;
      }),
    };
    const scheduler = createEarliestAlarmScheduler(storage);

    const earlier = scheduler.scheduleAlarm(2_000);
    const later = scheduler.scheduleAlarm(3_000);
    releaseFirstRead();
    await Promise.all([earlier, later]);

    expect(currentAlarm).toBe(2_000);
    expect(storage.setAlarm).toHaveBeenCalledOnce();
  });

  it("continues scheduling after a storage failure", async () => {
    const storage = createStorage(null);
    storage.getAlarm.mockRejectedValueOnce(new Error("storage unavailable"));
    const scheduler = createEarliestAlarmScheduler(storage);

    await expect(scheduler.scheduleAlarm(1_000)).rejects.toThrow("storage unavailable");
    await expect(scheduler.scheduleAlarm(2_000)).resolves.toBeUndefined();

    expect(storage.setAlarm).toHaveBeenCalledWith(2_000);
  });
});
