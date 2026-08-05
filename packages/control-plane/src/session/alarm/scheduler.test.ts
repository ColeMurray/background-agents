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
});
