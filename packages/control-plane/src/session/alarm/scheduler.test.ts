import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  createEarliestAlarmScheduler,
  handleAlarmDelivery,
  PersistedAlarmDeadlineStore,
  type AlarmDeadlineStore,
} from "./scheduler";
import { initSchema } from "../schema";
import type { SqlStorage } from "../sql-storage";
import { createNodeSqlStorage } from "../../../test/conformance/node-sqlite-storage";

function createDatabaseSql(db: DatabaseSync): SqlStorage {
  return createNodeSqlStorage(db).sql;
}

function createDeadlineStore(
  initialPending: number | null = null,
  initialInFlight: number | null = null
): AlarmDeadlineStore {
  let pending = initialPending;
  let inFlight = initialInFlight;
  let cancelled = false;
  return {
    pending: vi.fn(() => pending),
    earliest: vi.fn(() => {
      const values = [pending, inFlight].filter((value): value is number => value !== null);
      return values.length > 0 ? Math.min(...values) : null;
    }),
    cancelled: vi.fn(() => cancelled),
    setPending: vi.fn((value: number) => {
      pending = value;
    }),
    activate: vi.fn(() => {
      cancelled = false;
    }),
    clear: vi.fn(() => {
      pending = null;
      inFlight = null;
      cancelled = true;
    }),
    beginDelivery: vi.fn(() => {
      if (cancelled) return "cancelled" as const;
      if (inFlight === null) {
        inFlight = pending;
        pending = null;
      }
      return inFlight;
    }),
    completeDelivery: vi.fn(() => {
      inFlight = null;
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
  it("persists a deadline before setting the runtime alarm", async () => {
    const calls: string[] = [];
    const storage = createStorage(null);
    storage.setAlarm.mockImplementation(async () => {
      calls.push("runtime");
    });
    const deadlines = createDeadlineStore();
    vi.mocked(deadlines.setPending).mockImplementation(() => calls.push("persisted"));
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await scheduler.schedule(2_000);

    expect(calls).toEqual(["persisted", "runtime"]);
  });

  it("replaces a later persisted deadline", async () => {
    const storage = createStorage(3_000);
    const deadlines = createDeadlineStore(3_000);
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await scheduler.schedule(2_000);

    expect(deadlines.setPending).toHaveBeenCalledWith(2_000);
    expect(storage.setAlarm).toHaveBeenCalledWith(2_000);
  });

  it.each([1_000, 2_000])("preserves an existing pending deadline at %s", async (current) => {
    const storage = createStorage(current);
    const deadlines = createDeadlineStore(current);
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await scheduler.schedule(2_000);

    expect(deadlines.setPending).not.toHaveBeenCalled();
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("reconciles a missing runtime alarm from persisted state", async () => {
    const storage = createStorage(null);
    const deadlines = createDeadlineStore(2_000);
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await scheduler.schedule(3_000);

    expect(storage.setAlarm).toHaveBeenCalledWith(2_000);
  });

  it("retains persisted state when setting the runtime alarm fails", async () => {
    const storage = createStorage(null);
    storage.setAlarm.mockRejectedValueOnce(new Error("runtime unavailable"));
    const deadlines = createDeadlineStore();
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await expect(scheduler.schedule(2_000)).rejects.toThrow("runtime unavailable");

    expect(deadlines.pending()).toBe(2_000);
  });

  it("does not mutate the runtime when persistence fails", async () => {
    const storage = createStorage(null);
    const deadlines = createDeadlineStore();
    vi.mocked(deadlines.setPending).mockImplementationOnce(() => {
      throw new Error("persistence unavailable");
    });
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await expect(scheduler.schedule(2_000)).rejects.toThrow("persistence unavailable");

    expect(storage.getAlarm).not.toHaveBeenCalled();
    expect(storage.setAlarm).not.toHaveBeenCalled();
  });

  it("clears persisted state before deleting the runtime alarm", async () => {
    const calls: string[] = [];
    const storage = createStorage(2_000);
    storage.deleteAlarm.mockImplementation(async () => {
      calls.push("runtime");
    });
    const deadlines = createDeadlineStore(2_000);
    vi.mocked(deadlines.clear).mockImplementation(() => calls.push("persisted"));
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await scheduler.cancel();

    expect(calls).toEqual(["persisted", "runtime"]);
  });

  it("keeps cancellation authoritative when runtime deletion fails", async () => {
    const storage = createStorage(2_000);
    storage.deleteAlarm.mockRejectedValueOnce(new Error("runtime unavailable"));
    const deadlines = createDeadlineStore(2_000);
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await expect(scheduler.cancel()).rejects.toThrow("runtime unavailable");

    expect(deadlines.pending()).toBeNull();
  });

  it("replaces a stale cancelled runtime alarm before activating new work", async () => {
    const storage = createStorage(1_000);
    storage.deleteAlarm.mockRejectedValueOnce(new Error("runtime unavailable"));
    const deadlines = createDeadlineStore(1_000);
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await expect(scheduler.cancel()).rejects.toThrow("runtime unavailable");
    await scheduler.schedule(3_000);

    expect(storage.deleteAlarm).toHaveBeenCalledTimes(2);
    expect(storage.setAlarm).toHaveBeenCalledWith(3_000);
    expect(deadlines.activate).toHaveBeenCalledOnce();
  });

  it("rehydrates pending work persisted behind a cancellation tombstone", async () => {
    const storage = createStorage(1_000);
    const deadlines = createDeadlineStore(1_000);
    deadlines.clear();
    deadlines.setPending(3_000);
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await scheduler.rehydrate();

    expect(storage.deleteAlarm).toHaveBeenCalledOnce();
    expect(storage.setAlarm).toHaveBeenCalledWith(3_000);
    expect(deadlines.activate).toHaveBeenCalledOnce();
  });

  it("reports the persisted pending alarm", async () => {
    const scheduler = createEarliestAlarmScheduler(
      createStorage(3_000),
      createDeadlineStore(2_000)
    );

    await expect(scheduler.current()).resolves.toBe(2_000);
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
    const deadlines = createDeadlineStore();
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    const earlier = scheduler.schedule(2_000);
    const later = scheduler.schedule(3_000);
    releaseFirstRead();
    await Promise.all([earlier, later]);

    await expect(scheduler.current()).resolves.toBe(2_000);
    expect(deadlines.setPending).toHaveBeenCalledOnce();
  });

  it("continues scheduling after a runtime storage failure", async () => {
    const storage = createStorage(null);
    storage.getAlarm.mockRejectedValueOnce(new Error("storage unavailable"));
    const scheduler = createEarliestAlarmScheduler(storage, createDeadlineStore());

    await expect(scheduler.schedule(1_000)).rejects.toThrow("storage unavailable");
    await expect(scheduler.schedule(2_000)).resolves.toBeUndefined();

    expect(storage.setAlarm).toHaveBeenCalledWith(1_000);
  });

  it("re-arms the earliest persisted pending or retry deadline on rehydration", async () => {
    const deadlines = createDeadlineStore(3_000, 2_000);
    const adoptedStorage = createStorage(null);

    await createEarliestAlarmScheduler(adoptedStorage, deadlines).rehydrate();

    expect(adoptedStorage.setAlarm).toHaveBeenCalledWith(2_000);
    expect(deadlines.pending()).toBe(3_000);
  });

  it("acknowledges a delivered deadline without clearing its replacement", async () => {
    const deadlines = createDeadlineStore(2_000);

    await handleAlarmDelivery(
      deadlines,
      async () => deadlines.setPending(3_000),
      async () => {}
    );

    expect(deadlines.pending()).toBe(3_000);
    expect(deadlines.completeDelivery).toHaveBeenCalledOnce();
  });

  it("retains a delivered deadline when handling fails", async () => {
    const deadlines = createDeadlineStore(2_000);

    await expect(
      handleAlarmDelivery(
        deadlines,
        async () => {
          throw new Error("handler failed");
        },
        async () => {}
      )
    ).rejects.toThrow("handler failed");

    expect(deadlines.earliest()).toBe(2_000);
    expect(deadlines.completeDelivery).not.toHaveBeenCalled();
  });

  it("retries a failed delivery and re-arms its replacement", async () => {
    const deadlines = createDeadlineStore(2_000);
    const storage = createStorage(null);
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await expect(
      handleAlarmDelivery(
        deadlines,
        async () => {
          await scheduler.schedule(3_000);
          throw new Error("handler failed");
        },
        () => scheduler.rearmPending()
      )
    ).rejects.toThrow("handler failed");
    await scheduler.rehydrate();
    storage.deleteAlarm.mockClear();
    await storage.deleteAlarm();
    await handleAlarmDelivery(
      deadlines,
      async () => {},
      () => scheduler.rearmPending()
    );

    expect(deadlines.pending()).toBe(3_000);
    expect(deadlines.completeDelivery).toHaveBeenCalledOnce();
    expect(storage.setAlarm).toHaveBeenLastCalledWith(3_000);
  });

  it("retains delivery identity when replacement re-arming fails", async () => {
    const deadlines = createDeadlineStore(3_000, 2_000);
    const storage = createStorage(null);
    storage.setAlarm.mockRejectedValueOnce(new Error("runtime unavailable"));
    const scheduler = createEarliestAlarmScheduler(storage, deadlines);

    await expect(
      handleAlarmDelivery(
        deadlines,
        async () => {},
        () => scheduler.rearmPending()
      )
    ).rejects.toThrow("runtime unavailable");

    expect(deadlines.earliest()).toBe(2_000);
    expect(deadlines.completeDelivery).not.toHaveBeenCalled();
    await handleAlarmDelivery(
      deadlines,
      async () => {},
      () => scheduler.rearmPending()
    );
    expect(deadlines.pending()).toBe(3_000);
    expect(storage.setAlarm).toHaveBeenLastCalledWith(3_000);
  });

  it("suppresses a stale runtime delivery after cancellation", async () => {
    const deadlines = createDeadlineStore(2_000);
    const handle = vi.fn(async () => {});

    deadlines.clear();
    await handleAlarmDelivery(deadlines, handle, async () => {});

    expect(handle).not.toHaveBeenCalled();
  });
});

describe("PersistedAlarmDeadlineStore", () => {
  it("atomically separates a retried delivery from its pending replacement", () => {
    const db = new DatabaseSync(":memory:");
    const sql = createDatabaseSql(db);
    initSchema(sql);
    const deadlines = new PersistedAlarmDeadlineStore(sql);

    deadlines.setPending(2_000);
    expect(deadlines.beginDelivery()).toBe(2_000);
    deadlines.setPending(3_000);

    expect(deadlines.beginDelivery()).toBe(2_000);
    expect(deadlines.pending()).toBe(3_000);
    deadlines.completeDelivery();
    expect(deadlines.earliest()).toBe(3_000);

    deadlines.clear();
    expect(deadlines.beginDelivery()).toBe("cancelled");
    deadlines.setPending(4_000);
    expect(deadlines.beginDelivery()).toBe("cancelled");
    deadlines.activate();
    expect(deadlines.beginDelivery()).toBe(4_000);

    db.close();
  });
});
