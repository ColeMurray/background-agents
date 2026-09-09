/**
 * The Node host's cron: one timer per scheduled job, armed for the job's
 * next occurrence in UTC (the zone the Worker's triggers fire in) and
 * re-armed as soon as it fires, so a run's duration never shifts the
 * schedule. A slot whose previous run is still going is skipped and
 * logged: the jobs are idempotent and claim their work with compare-and-
 * swap, so a missed slot costs one interval, while two overlapping runs
 * of the same job would only contend.
 *
 * The clock is read per arm and per fire, so a timer that fired early
 * against the wall clock re-arms for the same slot instead of running it.
 */

import { nextCronOccurrence } from "@open-inspect/shared/cron";
import type { Logger } from "../logger";
import { settlesWithin } from "./background-tasks";
import type { ScheduledJob } from "../scheduled-jobs";

/** The longest delay a single timer can hold; farther slots re-arm. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;

export interface CronLoopOptions {
  jobs: readonly ScheduledJob[];
  /** Run `job` for the slot that fired; the host builds the job's dependencies here. */
  run: (job: ScheduledJob, nowMs: number) => Promise<void>;
  log: Logger;
  now?: () => number;
}

export class CronLoop {
  private readonly jobs: readonly ScheduledJob[];
  private readonly run: (job: ScheduledJob, nowMs: number) => Promise<void>;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<void>>();
  private started = false;

  constructor(options: CronLoopOptions) {
    this.jobs = options.jobs;
    this.run = options.run;
    this.log = options.log;
    this.now = options.now ?? (() => Date.now());
  }

  /** Arm every job for its next slot. */
  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of this.jobs) this.arm(job);
  }

  /** Fire nothing further. Runs in progress are not interrupted. */
  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * Wait for every run in progress for at most `timeoutMs`. Runs still
   * going at the deadline are logged by job and left running; returns how
   * many there were.
   */
  async drain(timeoutMs: number): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    while (this.running.size > 0) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || !(await settlesWithin([...this.running.values()], remaining))) break;
    }
    if (this.running.size > 0) {
      this.log.warn("scheduled_job.drain_timeout", {
        event: "scheduled_job.drain_timeout",
        timeout_ms: timeoutMs,
        jobs: [...this.running.keys()],
      });
    }
    return this.running.size;
  }

  private arm(job: ScheduledJob): void {
    if (!this.started) return;
    const nowMs = this.now();
    const slotMs = nextCronOccurrence(job.cron, "UTC", new Date(nowMs)).getTime();
    const timer = setTimeout(
      () => this.fire(job, slotMs),
      Math.min(Math.max(0, slotMs - nowMs), MAX_TIMER_DELAY_MS)
    );
    this.timers.set(job.name, timer);
  }

  private fire(job: ScheduledJob, slotMs: number): void {
    this.timers.delete(job.name);
    // A capped or early timer: the slot is still ahead, so wait for it.
    if (this.now() < slotMs) {
      this.arm(job);
      return;
    }
    this.arm(job);
    if (this.running.has(job.name)) {
      this.log.warn("scheduled_job.skipped", {
        event: "scheduled_job.skipped",
        job: job.name,
        slot: new Date(slotMs).toISOString(),
        reason: "previous_run_in_progress",
      });
      return;
    }
    const run = this.run(job, this.now())
      .catch((error: unknown) => {
        this.log.error("scheduled_job.failed", {
          event: "scheduled_job.failed",
          job: job.name,
          slot: new Date(slotMs).toISOString(),
          error: error instanceof Error ? error : String(error),
        });
      })
      .finally(() => {
        this.running.delete(job.name);
      });
    this.running.set(job.name, run);
  }
}
