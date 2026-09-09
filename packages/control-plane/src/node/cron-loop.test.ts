import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import type { ScheduledJob } from "../scheduled-jobs";
import { CronLoop } from "./cron-loop";

const T0 = Date.UTC(2026, 0, 1, 0, 0, 30);

function fakeLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function job(name: string, cron: string): ScheduledJob {
  return { name, cron, run: async () => {} };
}

describe("CronLoop", () => {
  let log: Logger;
  let loop: CronLoop | null;

  beforeEach(() => {
    vi.useFakeTimers({ now: T0 });
    log = fakeLogger();
    loop = null;
  });

  afterEach(() => {
    loop?.stop();
    vi.useRealTimers();
  });

  it("fires each job at its next slot and re-arms from the slot", async () => {
    const run = vi.fn<(job: ScheduledJob, nowMs: number) => Promise<void>>(async () => {});
    loop = new CronLoop({ jobs: [job("tick", "* * * * *"), job("hourly", "0 * * * *")], run, log });
    loop.start();

    await vi.advanceTimersByTimeAsync(29_999);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ name: "tick" }), T0 + 30_000);

    await vi.advanceTimersByTimeAsync(60_000 * 59 + 30_000);
    const names = run.mock.calls.map(([called]) => called.name);
    expect(names.filter((name) => name === "tick")).toHaveLength(60);
    expect(names.filter((name) => name === "hourly")).toHaveLength(1);
  });

  it("skips a slot while the previous run of the same job is still going", async () => {
    let finish!: () => void;
    const run = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    loop = new CronLoop({ jobs: [job("tick", "* * * * *")], run, log });
    loop.start();

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith(
      "scheduled_job.skipped",
      expect.objectContaining({ job: "tick", reason: "previous_run_in_progress" })
    );

    finish();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("logs a failed run and keeps the schedule", async () => {
    const run = vi
      .fn<(job: ScheduledJob, nowMs: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(undefined);
    loop = new CronLoop({ jobs: [job("tick", "* * * * *")], run, log });
    loop.start();

    await vi.advanceTimersByTimeAsync(30_000);
    expect(log.error).toHaveBeenCalledWith(
      "scheduled_job.failed",
      expect.objectContaining({ job: "tick", error: expect.any(Error) })
    );
    await vi.advanceTimersByTimeAsync(60_000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("holds a far slot across the timer's maximum delay", async () => {
    const run = vi.fn(async () => {});
    loop = new CronLoop({ jobs: [job("yearly", "0 0 1 1 *")], run, log });
    loop.start();

    await vi.advanceTimersByTimeAsync(2 ** 31);
    expect(run).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("reports a run that outlives the drain budget instead of waiting for it", async () => {
    const run = vi.fn(() => new Promise<void>(() => {}));
    loop = new CronLoop({ jobs: [job("tick", "* * * * *")], run, log });
    loop.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);

    loop.stop();
    const drained = loop.drain(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await drained).toBe(1);
    expect(log.warn).toHaveBeenCalledWith(
      "scheduled_job.drain_timeout",
      expect.objectContaining({ timeout_ms: 1_000, jobs: ["tick"] })
    );
  });

  it("stops firing once stopped and drains the run in progress", async () => {
    let finish!: () => void;
    const settled = vi.fn();
    const run = vi.fn(() =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }).then(settled)
    );
    loop = new CronLoop({ jobs: [job("tick", "* * * * *")], run, log });
    loop.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).toHaveBeenCalledTimes(1);

    loop.stop();
    const drained = loop.drain(5_000);
    finish();
    expect(await drained).toBe(0);
    expect(settled).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
