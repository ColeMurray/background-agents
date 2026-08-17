import { describe, expect, it, vi } from "vitest";
import {
  createEarliestAlarmScheduler,
  handleAlarmDelivery,
  rehydrateAlarmScheduler,
  type AlarmDeadlineStore,
} from "./scheduler";

function createDeadlineStore(initial: number | null = null): AlarmDeadlineStore {
  let deadline = initial;
  return {
    current: vi.fn(() => deadline),
    set: vi.fn((value: number) => {
      deadline = value;
    }),
    clear: vi.fn(() => {
      deadline = null;
    }),
    clearIf: vi.fn((value: number) => {
      if (deadline === value) deadline = null;
    }),
  };
}

function createStorage(initial: number | null) {
  let currentAlarm = initial;
  return {
    getAlarm: vi.fn(async () => currentAlarm),
    setAlarm: vi.fn(async (timestamp: number) => {
      currentAlarm = timestamp;
    }),
    deleteAlarm: vi.fn(async () => {
      currentAlarm = null;
    }),
  };
}

describe("createEarliestAlarmScheduler", () => {
  it("sets and persists a deadline when no alarm exists", async () => {
    const storage = createStorage(null);
    const deadlines = createDeadlineStore();
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await scheduler.schedule(2_000);

    expect(storage.setAlarm).toHaveBeenCalledWith(2_000);
    expect(deadlines.set).toHaveBeenCalledWith(2_000);
  });

  it("replaces a later alarm", async () => {
    const storage = createStorage(3_000);
    const deadlines = createDeadlineStore(3_000);
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await scheduler.schedule(2_000);

    expect(storage.setAlarm).toHaveBeenCalledWith(2_000);
    expect(deadlines.set).toHaveBeenLastCalledWith(2_000);
  });

  it.each([1_000, 2_000])("preserves and persists an existing alarm at %s", async (current) => {
    const storage = createStorage(current);
    const deadlines = createDeadlineStore();
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await scheduler.schedule(2_000);

    expect(storage.setAlarm).not.toHaveBeenCalled();
    expect(deadlines.set).toHaveBeenCalledWith(current);
  });

  it("reports and cancels the current alarm", async () => {
    const storage = createStorage(2_000);
    const deadlines = createDeadlineStore(2_000);
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await expect(scheduler.current()).resolves.toBe(2_000);
    await scheduler.cancel();

    await expect(scheduler.current()).resolves.toBeNull();
    expect(storage.deleteAlarm).toHaveBeenCalledOnce();
    expect(deadlines.clear).toHaveBeenCalledOnce();
  });

  it("serializes concurrent updates so a later deadline cannot replace an earlier one", async () => {
    const storage = createStorage(null);
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    storage.getAlarm.mockImplementationOnce(async () => {
      await firstRead;
      return null;
    });
    const scheduler = createEarliestAlarmScheduler(storage, createDeadlineStore());

    const earlier = scheduler.schedule(2_000);
    const later = scheduler.schedule(3_000);
    releaseFirstRead();
    await Promise.all([earlier, later]);

    await expect(scheduler.current()).resolves.toBe(2_000);
    expect(storage.setAlarm).toHaveBeenCalledOnce();
  });

  it("continues scheduling after a storage failure", async () => {
    const storage = createStorage(null);
    storage.getAlarm.mockRejectedValueOnce(new Error("storage unavailable"));
    const scheduler = createEarliestAlarmScheduler(storage, createDeadlineStore());

    await expect(scheduler.schedule(1_000)).rejects.toThrow("storage unavailable");
    await expect(scheduler.schedule(2_000)).resolves.toBeUndefined();

    expect(storage.setAlarm).toHaveBeenCalledWith(2_000);
  });

  it("re-arms a persisted deadline when a runtime is rehydrated", async () => {
    const deadlines = createDeadlineStore(2_000);
    const adoptedStorage = createStorage(null);
    const scheduler = createEarliestAlarmScheduler(adoptedStorage, deadlines);

    await rehydrateAlarmScheduler(scheduler, deadlines);

    expect(adoptedStorage.setAlarm).toHaveBeenCalledWith(2_000);
    await expect(scheduler.current()).resolves.toBe(2_000);
  });

  it("acknowledges a delivered deadline without clearing its replacement", async () => {
    const deadlines = createDeadlineStore(2_000);

    await handleAlarmDelivery(deadlines, async () => deadlines.set(3_000));

    expect(deadlines.current()).toBe(3_000);
  });

  it("retains a delivered deadline when handling fails", async () => {
    const deadlines = createDeadlineStore(2_000);

    await expect(
      handleAlarmDelivery(deadlines, async () => {
        throw new Error("handler failed");
      })
    ).rejects.toThrow("handler failed");

    expect(deadlines.current()).toBe(2_000);
    expect(deadlines.clearIf).not.toHaveBeenCalled();
  });
});
