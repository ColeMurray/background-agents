import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../logger";
import {
  createEarliestAlarmScheduler,
  handleAlarmDelivery,
  PersistedAlarmDeadlineStore,
} from "../session/alarm/scheduler";
import { initSchema } from "../session/schema";
import { HostAlarmClock } from "./host-alarm-clock";
import { openHostAlarmIndex, type HostAlarmIndex } from "./host-alarm-index";
import { createNodeSqlStorage } from "./sqlite-storage";

const log = createLogger("host-alarm-clock-test");

describe("HostAlarmClock", () => {
  let dataDir: string;
  let index: HostAlarmIndex;
  let delivered: string[];
  let deliver: ReturnType<typeof vi.fn<(sessionId: string) => Promise<void>>>;
  let clock: HostAlarmClock;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    dataDir = mkdtempSync(join(tmpdir(), "host-alarm-clock-"));
    index = openHostAlarmIndex(dataDir);
    delivered = [];
    deliver = vi.fn(async (sessionId: string) => {
      delivered.push(sessionId);
    });
    clock = new HostAlarmClock({ index, deliver, log });
    clock.start();
  });

  afterEach(() => {
    clock.stop();
    index.close();
    rmSync(dataDir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it("fires a session at its deadline and consumes the record before the handler runs", async () => {
    const store = clock.storeFor("s1");
    let armedDuringDelivery: number | null = 1;
    deliver.mockImplementationOnce(async () => {
      armedDuringDelivery = await store.getAlarm();
    });
    await store.setAlarm(Date.now() + 5_000);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(deliver).toHaveBeenCalledWith("s1");
    expect(armedDuringDelivery).toBeNull();
    expect(await store.getAlarm()).toBeNull();
  });

  it("fires in deadline order across sessions and follows an earlier replacement", async () => {
    await clock.storeFor("late").setAlarm(Date.now() + 10_000);
    await clock.storeFor("soon").setAlarm(Date.now() + 2_000);
    await clock.storeFor("late").setAlarm(Date.now() + 3_000);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(delivered).toEqual(["soon"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toEqual(["soon", "late"]);
  });

  it("does not fire a deleted deadline", async () => {
    const store = clock.storeFor("s1");
    await store.setAlarm(Date.now() + 1_000);
    await store.deleteAlarm();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deliver).not.toHaveBeenCalled();
  });

  it("reaches a deadline farther away than one timer can hold", async () => {
    const far = Date.now() + 2 ** 31 + 60_000;
    await clock.storeFor("s1").setAlarm(far);
    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(deliver).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(delivered).toEqual(["s1"]);
  });

  it("fires again for a deadline the handler arms while it runs", async () => {
    const store = clock.storeFor("s1");
    deliver.mockImplementationOnce(async () => {
      delivered.push("first");
      await store.setAlarm(Date.now() + 1_000);
    });
    await store.setAlarm(Date.now() + 1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(delivered).toEqual(["first", "s1"]);
  });

  it("never overlaps two deliveries to one session", async () => {
    const store = clock.storeFor("s1");
    let release!: () => void;
    deliver.mockImplementationOnce(async () => {
      delivered.push("slow");
      // Re-arm for right now while still running: the clock must wait.
      await store.setAlarm(Date.now());
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await store.setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered).toEqual(["slow"]);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(["slow", "s1"]);
  });

  it("retries a failed delivery with backoff and drops it after the last attempt", async () => {
    deliver.mockRejectedValue(new Error("handler failed"));
    await clock.storeFor("s1").setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(deliver).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliver).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deliver).toHaveBeenCalledTimes(3);
    // 120s, 240s, 480s complete the six attempts; nothing follows.
    await vi.advanceTimersByTimeAsync(120_000 + 240_000 + 480_000);
    expect(deliver).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(deliver).toHaveBeenCalledTimes(6);
    expect(index.earliest()).toBeNull();
  });

  it("resumes deadlines recorded before a restart", async () => {
    await clock.storeFor("evicted").setAlarm(Date.now() + 2_000);
    clock.stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(deliver).not.toHaveBeenCalled();

    const restarted = new HostAlarmClock({ index, deliver, log });
    restarted.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(["evicted"]);
    restarted.stop();
  });

  it("drain waits for running deliveries", async () => {
    let release!: () => void;
    deliver.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await clock.storeFor("s1").setAlarm(Date.now());
    await vi.advanceTimersByTimeAsync(0);
    let drained = false;
    const drain = clock.drain().then(() => {
      drained = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(drained).toBe(false);
    release();
    await drain;
    expect(drained).toBe(true);
  });

  describe("as the session core's alarm store", () => {
    let db: DatabaseSync;
    let deadlines: PersistedAlarmDeadlineStore;

    beforeEach(() => {
      db = new DatabaseSync(":memory:");
      const { sql } = createNodeSqlStorage(db);
      initSchema(sql);
      deadlines = new PersistedAlarmDeadlineStore(sql);
    });

    afterEach(() => {
      db.close();
    });

    it("schedules the earliest deadline, delivers it once, and re-arms the replacement", async () => {
      const scheduler = createEarliestAlarmScheduler(clock.storeFor("s1"), deadlines);
      const handled: number[] = [];
      deliver.mockImplementation(() =>
        handleAlarmDelivery(
          deadlines,
          async () => {
            handled.push(Date.now());
          },
          () => scheduler.rearmPending()
        )
      );
      await scheduler.schedule(Date.now() + 5_000);
      await scheduler.schedule(Date.now() + 1_000);
      await scheduler.schedule(Date.now() + 3_000);
      expect(await scheduler.current()).toBe(1_001_000);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(handled).toEqual([1_001_000]);
      // The handler consumed the deadline and nothing was pending behind it.
      expect(await clock.storeFor("s1").getAlarm()).toBeNull();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(handled).toEqual([1_001_000]);
    });

    it("does not deliver after cancel, and rehydrates work scheduled behind the cancellation", async () => {
      const scheduler = createEarliestAlarmScheduler(clock.storeFor("s1"), deadlines);
      await scheduler.schedule(Date.now() + 1_000);
      await scheduler.cancel();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(deliver).not.toHaveBeenCalled();

      // Work persisted while cancelled is armed again by rehydrate, as after a restart.
      deadlines.setPending(Date.now() + 500);
      await scheduler.rehydrate();
      await vi.advanceTimersByTimeAsync(500);
      expect(delivered).toEqual(["s1"]);
    });

    it("rearmPending re-arms a pending deadline the host has lost", async () => {
      const scheduler = createEarliestAlarmScheduler(clock.storeFor("s1"), deadlines);
      await scheduler.schedule(Date.now() + 1_000);
      index.delete("s1");
      await scheduler.rearmPending();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(delivered).toEqual(["s1"]);
    });
  });
});
