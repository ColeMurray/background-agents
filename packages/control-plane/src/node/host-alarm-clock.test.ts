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
import { HostAlarmClock, MAX_RETRIES, RETRY_BASE_DELAY_MS } from "./host-alarm-clock";
import { openHostAlarmIndex, type HostAlarmIndex } from "./host-alarm-index";
import { createNodeSqlStorage } from "./sqlite-storage";

const log = createLogger("host-alarm-clock-test");

/** The delay before retry number `n` (1-based). */
const retryDelay = (n: number): number => RETRY_BASE_DELAY_MS * 2 ** (n - 1);
/** Time for retries `from` through `to` inclusive to elapse. */
const retriesElapsed = (from: number, to: number): number => {
  let total = 0;
  for (let n = from; n <= to; n += 1) total += retryDelay(n);
  return total;
};

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

  it("never overlaps two deliveries to one session, and waits without spinning", async () => {
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
    const due = vi.spyOn(index, "due");
    await store.setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100);
    const ticksBefore = due.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(delivered).toEqual(["slow"]);
    // Nothing else is armed, so nothing wakes the clock while it waits.
    expect(due.mock.calls.length).toBe(ticksBefore);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(delivered).toEqual(["slow", "s1"]);
  });

  it("fires other sessions while one delivery is still running", async () => {
    let release!: () => void;
    deliver.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await clock.storeFor("slow").setAlarm(Date.now() + 100);
    await clock.storeFor("other").setAlarm(Date.now() + 200);
    await vi.advanceTimersByTimeAsync(200);
    expect(deliver).toHaveBeenCalledWith("slow");
    expect(deliver).toHaveBeenCalledWith("other");
    release();
  });

  it("delivers again after a restart when the previous process died mid-delivery", async () => {
    deliver.mockImplementationOnce(() => new Promise<void>(() => {}));
    await clock.storeFor("s1").setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(deliver).toHaveBeenCalledTimes(1);
    // The process dies here: the clock is abandoned with the claim on disk.
    clock.stop();

    const restarted = new HostAlarmClock({ index, deliver, log });
    restarted.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(delivered).toEqual(["s1"]);
    restarted.stop();
  });

  it("retries a failed delivery on the platform's backoff and stops after six retries", async () => {
    deliver.mockRejectedValue(new Error("handler failed"));
    await clock.storeFor("s1").setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(deliver).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(retryDelay(1));
    expect(deliver).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(retryDelay(2));
    expect(deliver).toHaveBeenCalledTimes(3);
    // The remaining retries complete the budget; nothing follows.
    await vi.advanceTimersByTimeAsync(retriesElapsed(3, MAX_RETRIES));
    expect(deliver).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(deliver).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    expect(index.earliest()).toBeNull();
  });

  it("keeps the retry count across a restart", async () => {
    deliver.mockRejectedValue(new Error("handler failed"));
    await clock.storeFor("s1").setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100 + retriesElapsed(1, 2));
    expect(deliver).toHaveBeenCalledTimes(3);
    clock.stop();

    const restarted = new HostAlarmClock({ index, deliver, log });
    restarted.start();
    await vi.advanceTimersByTimeAsync(retriesElapsed(3, MAX_RETRIES));
    expect(deliver).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(deliver).toHaveBeenCalledTimes(1 + MAX_RETRIES);
    restarted.stop();
  });

  it("delivers to overdue sessions a bounded number at a time after downtime", async () => {
    const releases = new Map<string, () => void>();
    deliver.mockImplementation(
      (sessionId) =>
        new Promise<void>((resolve) => {
          releases.set(sessionId, resolve);
        })
    );
    for (let i = 0; i < 10; i += 1) {
      index.set(`s${i}`, Date.now() - 1_000);
    }
    const bounded = new HostAlarmClock({ index, deliver, log, maxConcurrentDeliveries: 3 });
    bounded.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(deliver).toHaveBeenCalledTimes(3);

    // Each settled delivery lets the next overdue session start.
    let settled = 0;
    while (releases.size > 0) {
      const [sessionId, release] = [...releases.entries()][0]!;
      releases.delete(sessionId);
      release();
      settled += 1;
      await vi.advanceTimersByTimeAsync(0);
      expect(deliver).toHaveBeenCalledTimes(Math.min(10, 3 + settled));
    }
    expect(deliver).toHaveBeenCalledTimes(10);
    expect(index.earliest()).toBeNull();
    bounded.stop();
  });

  it("gives a newly armed deadline its full retry budget", async () => {
    deliver.mockRejectedValue(new Error("handler failed"));
    const store = clock.storeFor("s1");
    await store.setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100 + retriesElapsed(1, 2));
    expect(deliver).toHaveBeenCalledTimes(3);
    // The session arms a new deadline: the three failures belonged to the old one.
    await store.setAlarm(Date.now() + 100);
    await vi.advanceTimersByTimeAsync(100 + retriesElapsed(1, MAX_RETRIES));
    expect(deliver).toHaveBeenCalledTimes(3 + 1 + MAX_RETRIES);
    await vi.advanceTimersByTimeAsync(10_000_000);
    expect(deliver).toHaveBeenCalledTimes(3 + 1 + MAX_RETRIES);
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

    it("retries a failed delivery sooner than the replacement its handler armed, then restores the replacement", async () => {
      const scheduler = createEarliestAlarmScheduler(clock.storeFor("s1"), deadlines);
      const replacement = Date.now() + 3_600_000;
      let attempts = 0;
      deliver.mockImplementation(() =>
        handleAlarmDelivery(
          deadlines,
          async () => {
            attempts += 1;
            if (attempts === 1) {
              await scheduler.schedule(replacement);
              throw new Error("first attempt failed");
            }
          },
          () => scheduler.rearmPending()
        )
      );
      await scheduler.schedule(Date.now() + 1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(attempts).toBe(1);
      expect(await clock.storeFor("s1").getAlarm()).toBe(Date.now() + retryDelay(1));

      await vi.advanceTimersByTimeAsync(retryDelay(1));
      expect(attempts).toBe(2);
      // The retry acknowledged the failed deadline and re-armed its replacement.
      expect(deadlines.pending()).toBe(replacement);
      expect(await clock.storeFor("s1").getAlarm()).toBe(replacement);
      await vi.advanceTimersByTimeAsync(replacement - Date.now());
      expect(attempts).toBe(3);
    });

    it("after the host stops retrying, the session's next rehydrate re-arms the deadline", async () => {
      const scheduler = createEarliestAlarmScheduler(clock.storeFor("s1"), deadlines);
      deliver.mockImplementation(() =>
        handleAlarmDelivery(
          deadlines,
          async () => {
            throw new Error("always fails");
          },
          () => scheduler.rearmPending()
        )
      );
      await scheduler.schedule(Date.now() + 100);
      await vi.advanceTimersByTimeAsync(100 + retriesElapsed(1, MAX_RETRIES));
      expect(deliver).toHaveBeenCalledTimes(1 + MAX_RETRIES);
      expect(index.earliest()).toBeNull();
      // The session file still holds the deadline in flight.
      expect(deadlines.earliest()).toBe(1_000_100);

      deliver.mockImplementation(async () => {
        delivered.push("recovered");
      });
      await scheduler.rehydrate();
      await vi.advanceTimersByTimeAsync(0);
      expect(delivered).toEqual(["recovered"]);
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
