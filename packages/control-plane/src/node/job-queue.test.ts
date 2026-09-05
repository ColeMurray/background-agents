import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JOB_KINDS, type JobDeps, type JobOutcome } from "../jobs";
import type { Logger } from "../logger";
import { JOB_CLAIM_LEASE_MS, LEASE_SWEEP_INTERVAL_MS, NodeJobs } from "./job-queue";
import { openJobStore, type JobStore } from "./job-store";

const KIND = "image_build.finalize" as const;
const PAYLOAD = { version: 1 as const, buildId: "build-1", completionHash: "a".repeat(64) };
const { maxAttempts, retryDelayMs } = JOB_KINDS[KIND].retry;

let dataDir: string;
let store: JobStore;
let log: Logger;
let ids = 0;

function fakeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
}

/**
 * A queue whose only handler is `handle`, over a real store. Time is the
 * caller's: `vi.useFakeTimers` drives both the poller's timer and its clock.
 */
function createQueue(
  handle: (typeof JOB_KINDS)[typeof KIND]["handle"],
  maxConcurrentJobs?: number
) {
  vi.spyOn(JOB_KINDS[KIND], "handle").mockImplementation(handle);
  return new NodeJobs({
    store,
    deps: () => ({ env: {}, db: {}, log }) as unknown as Omit<JobDeps, "correlation">,
    log,
    now: () => Date.now(),
    maxConcurrentJobs,
    newId: () => `job-${++ids}`,
  });
}

/** Let the poller's timer fire and every delivery it started settle. */
async function runPoller(queue: NodeJobs): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
  await queue.drain();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(10_000);
  ids = 0;
  dataDir = mkdtempSync(join(tmpdir(), "oi-job-queue-"));
  store = openJobStore(dataDir);
  log = fakeLogger();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  store.close();
  rmSync(dataDir, { recursive: true, force: true });
});

describe("NodeJobs", () => {
  it("records a sent job as runnable at once and delivers it after start", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => "ack");
    const queue = createQueue(handle);

    await queue.send({ kind: KIND, payload: PAYLOAD });
    expect(store.earliest([KIND])).toBe(10_000);
    queue.start();
    await runPoller(queue);

    expect(handle).toHaveBeenCalledWith(
      PAYLOAD,
      { attempts: 1, maxAttempts },
      expect.objectContaining({ correlation: { trace_id: "job-1", request_id: "job-1" } })
    );
    expect(queue.stats()).toMatchObject({ pending: 0, running: 0, dead: 0 });
  });

  it("delivers nothing before start, or after stop", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => "ack");
    const queue = createQueue(handle);

    await queue.send({ kind: KIND, payload: PAYLOAD });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handle).not.toHaveBeenCalled();

    queue.start();
    queue.stop();
    await queue.send({ kind: KIND, payload: PAYLOAD });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(handle).not.toHaveBeenCalled();
    expect(queue.stats().pending).toBe(2);
  });

  it("delivers a retry again after the kind's own delay", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => ({ retry: true }));
    const queue = createQueue(handle);

    await queue.send({ kind: KIND, payload: PAYLOAD });
    queue.start();
    await runPoller(queue);

    expect(handle).toHaveBeenCalledOnce();
    expect(store.earliest([KIND])).toBe(10_000 + retryDelayMs);

    await vi.advanceTimersByTimeAsync(retryDelayMs);
    await queue.drain();
    expect(handle).toHaveBeenCalledTimes(2);
    expect(handle).toHaveBeenLastCalledWith(
      PAYLOAD,
      { attempts: 2, maxAttempts },
      expect.anything()
    );
  });

  it("honours a delay the handler chose", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => ({ retry: true, delayMs: 300_000 }));
    const queue = createQueue(handle);

    await queue.send({ kind: KIND, payload: PAYLOAD });
    queue.start();
    await runPoller(queue);

    expect(store.earliest([KIND])).toBe(10_000 + 300_000);
  });

  it("buries a job that used its last attempt, keeping the row and the reason", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => ({ retry: true }));
    const queue = createQueue(handle);

    await queue.send({ kind: KIND, payload: PAYLOAD });
    queue.start();
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await vi.advanceTimersByTimeAsync(retryDelayMs);
      await queue.drain();
    }

    expect(handle).toHaveBeenCalledTimes(maxAttempts);
    expect(queue.stats()).toMatchObject({ pending: 0, running: 0, dead: 1 });
    expect(log.error).toHaveBeenCalledWith(
      "Job will not be delivered again",
      expect.objectContaining({ event: "jobs.dead", attempts: maxAttempts })
    );

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(handle).toHaveBeenCalledTimes(maxAttempts);
  });

  it("buries a recovered job that was interrupted on its final attempt, without delivering it again", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => "ack");
    const queue = createQueue(handle);
    store.add(
      { id: "interrupted", kind: KIND, payload: JSON.stringify(PAYLOAD), runAt: 10_000 },
      10_000
    );
    // The process died on the last delivery the policy allows.
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      store.claim(10_000, 1, [KIND], 10_000 + JOB_CLAIM_LEASE_MS);
      store.recoverExpiredClaims(10_000 + JOB_CLAIM_LEASE_MS);
    }

    queue.start();
    await runPoller(queue);

    expect(handle).not.toHaveBeenCalled();
    expect(queue.stats()).toMatchObject({ dead: 1 });
    expect(log.error).toHaveBeenCalledWith(
      "Job will not be delivered again",
      expect.objectContaining({
        attempts: maxAttempts + 1,
        error_message: "Attempts were exhausted before this delivery",
      })
    );
  });

  it("leaves a job whose kind this build does not know for the build that does", async () => {
    const queue = createQueue(vi.fn());
    store.add({ id: "future", kind: "session.completed", payload: "{}", runAt: 10_000 }, 10_000);

    queue.start();
    await runPoller(queue);

    // Still pending, not dead: a rollback must not consume a newer build's work.
    expect(queue.stats()).toMatchObject({ pending: 1, running: 0, dead: 0 });
  });

  it("does not schedule itself for a due job whose kind it cannot claim", async () => {
    const queue = createQueue(vi.fn());
    store.add({ id: "future", kind: "session.completed", payload: "{}", runAt: 10_000 }, 10_000);
    const claim = vi.spyOn(store, "claim");

    queue.start();
    await vi.advanceTimersByTimeAsync(LEASE_SWEEP_INTERVAL_MS - 1);

    // The row is due and never claimable, so waking for it would be a spin
    // that never makes progress: the poller waits for the lease sweep instead.
    expect(claim).not.toHaveBeenCalled();
    expect(queue.stats()).toMatchObject({ pending: 1, dead: 0 });
  });

  it("keeps the send durable and the timer alive when the store cannot say what is next", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => "ack");
    const queue = createQueue(handle);
    const earliest = vi.spyOn(store, "earliest").mockImplementation(() => {
      throw new Error("database is locked");
    });

    // The row is written before the poller is armed, so the send succeeded
    // however scheduling went.
    await expect(queue.send({ kind: KIND, payload: PAYLOAD })).resolves.toBeUndefined();
    queue.start();
    await vi.advanceTimersByTimeAsync(LEASE_SWEEP_INTERVAL_MS);
    await queue.drain();

    // Blind to what is due, the poller still wakes on its own interval.
    expect(handle).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith(
      "Jobs poller could not schedule its next wake-up",
      expect.objectContaining({ event: "jobs.arm_failed", error_message: "database is locked" })
    );

    earliest.mockRestore();
    await queue.send({ kind: KIND, payload: PAYLOAD });
    await runPoller(queue);
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("retries an unreadable payload on the kind's policy rather than losing it", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => "ack");
    const queue = createQueue(handle);
    store.add({ id: "corrupt", kind: KIND, payload: "{not json", runAt: 10_000 }, 10_000);

    queue.start();
    await runPoller(queue);

    expect(handle).not.toHaveBeenCalled();
    expect(queue.stats()).toMatchObject({ pending: 1, dead: 0 });
    expect(store.earliest([KIND])).toBe(10_000 + retryDelayMs);
  });

  it("delivers no more than the concurrency bound at once, and starts the rest as they settle", async () => {
    let running = 0;
    let peak = 0;
    const release: Array<() => void> = [];
    const handle = vi.fn(async (): Promise<JobOutcome> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise<void>((resolve) => release.push(resolve));
      running -= 1;
      return "ack";
    });
    const queue = createQueue(handle, 2);

    for (let i = 0; i < 5; i += 1) await queue.send({ kind: KIND, payload: PAYLOAD });
    queue.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(handle).toHaveBeenCalledTimes(2);

    while (release.length > 0) {
      release.shift()!();
      await vi.advanceTimersByTimeAsync(1);
    }
    await queue.drain();

    expect(peak).toBe(2);
    expect(handle).toHaveBeenCalledTimes(5);
    expect(queue.stats().pending).toBe(0);
  });

  it("frees the slot a hung delivery holds once its lease runs out", async () => {
    const handle = vi.fn(
      () => new Promise<JobOutcome>(() => {}) // never settles
    );
    const queue = createQueue(handle, 1);

    await queue.send({ kind: KIND, payload: PAYLOAD });
    await queue.send({ kind: KIND, payload: PAYLOAD });
    queue.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(handle).toHaveBeenCalledOnce();
    expect(queue.stats()).toMatchObject({ running: 1, pending: 1 });

    // Nothing moves while the lease holds: the slot is legitimately busy.
    await vi.advanceTimersByTimeAsync(JOB_CLAIM_LEASE_MS - 2);
    expect(handle).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(2);
    expect(log.warn).toHaveBeenCalledWith(
      "Returning jobs whose claim expired",
      expect.objectContaining({ event: "jobs.claims_expired" })
    );
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("lets a redelivery finish even when the delivery it replaced comes back", async () => {
    let releaseFirst = (): void => {};
    const handle = vi
      .fn(async (): Promise<JobOutcome> => "ack")
      .mockImplementationOnce(async (): Promise<JobOutcome> => {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return "ack";
      });
    const queue = createQueue(handle);

    await queue.send({ kind: KIND, payload: PAYLOAD });
    queue.start();
    await vi.advanceTimersByTimeAsync(1);

    // The lease runs out, the job is redelivered, and the second delivery acks.
    await vi.advanceTimersByTimeAsync(JOB_CLAIM_LEASE_MS);
    expect(log.error).toHaveBeenCalledWith(
      "Job deliveries outlived their lease and were abandoned",
      expect.objectContaining({ event: "jobs.delivery_abandoned" })
    );
    expect(handle).toHaveBeenCalledTimes(2);
    expect(queue.stats()).toMatchObject({ pending: 0, running: 0, dead: 0 });

    // Now the abandoned delivery returns. Its token is stale, so it changes
    // nothing, and it does not evict the delivery that replaced it.
    releaseFirst();
    await queue.drain();
    expect(queue.stats()).toMatchObject({ pending: 0, running: 0, dead: 0 });
  });

  it("takes back a claim a dead process left, rather than waiting out its lease", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => "ack");
    // A row left `running` on disk by a process that is gone, its lease with
    // most of the quarter hour still to run.
    store.add({ id: "orphan", kind: KIND, payload: JSON.stringify(PAYLOAD), runAt: 9_000 }, 9_000);
    store.claim(9_000, 1, [KIND], 9_000 + JOB_CLAIM_LEASE_MS);
    expect(store.stats(10_000)).toMatchObject({ running: 1, pending: 0 });

    const queue = createQueue(handle);
    queue.start();
    await runPoller(queue);

    expect(handle).toHaveBeenCalledOnce();
    expect(queueIsEmpty()).toBe(true);
    expect(log.warn).toHaveBeenCalledWith(
      "Returning jobs a previous process left claimed",
      expect.objectContaining({ event: "jobs.claims_recovered", job_ids: ["orphan"] })
    );
  });

  it("does not take back a job it is still delivering when it is started again", async () => {
    let release = (): void => {};
    const handle = vi.fn(async (): Promise<JobOutcome> => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return "ack";
    });
    const queue = createQueue(handle);

    await queue.send({ kind: KIND, payload: PAYLOAD });
    queue.start();
    // The delivery has claimed the job and is blocked in the handler.
    await vi.advanceTimersByTimeAsync(1);
    expect(handle).toHaveBeenCalledOnce();

    queue.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(handle).toHaveBeenCalledOnce();
    expect(queue.stats()).toMatchObject({ running: 1, pending: 0 });

    release();
    await queue.drain();
    expect(queueIsEmpty()).toBe(true);
  });

  it("keeps polling when the store fails, rather than rejecting out of the timer", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => "ack");
    const queue = createQueue(handle);
    const claim = vi.spyOn(store, "claim").mockImplementationOnce(() => {
      throw new Error("database is locked");
    });

    await queue.send({ kind: KIND, payload: PAYLOAD });
    queue.start();
    await runPoller(queue);

    expect(log.error).toHaveBeenCalledWith(
      "Jobs poller failed to claim work",
      expect.objectContaining({ event: "jobs.poll_failed", error_message: "database is locked" })
    );
    claim.mockRestore();
    await runPoller(queue);
    expect(handle).toHaveBeenCalledOnce();
  });

  it("logs a settlement it could not write, leaving the lease to return the job", async () => {
    const handle = vi.fn(async (): Promise<JobOutcome> => "ack");
    const queue = createQueue(handle);
    vi.spyOn(store, "complete").mockImplementation(() => {
      throw new Error("disk full");
    });

    await queue.send({ kind: KIND, payload: PAYLOAD });
    queue.start();
    await runPoller(queue);

    expect(log.error).toHaveBeenCalledWith(
      "Job delivery could not be settled",
      expect.objectContaining({ event: "jobs.settle_failed", error_message: "disk full" })
    );
    expect(queue.stats()).toMatchObject({ running: 1 });
  });
});

function queueIsEmpty(): boolean {
  const { pending, running, dead } = store.stats(Date.now());
  return pending === 0 && running === 0 && dead === 0;
}
