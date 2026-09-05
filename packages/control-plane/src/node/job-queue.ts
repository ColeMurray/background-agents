/**
 * The Node host's wiring of the jobs seam: `send` writes a row and one timer
 * for the whole process delivers what is due.
 *
 * This is the container's answer to a Cloudflare Queue consumer, and it
 * keeps that consumer's contract. `deliverJob` is the same entry point on
 * both hosts, so parsing, handler failures and the retry answer are decided
 * in one place; what differs is only who enforces the policy. Cloudflare
 * enforces `max_retries` and `retry_delay` from the queue consumer's
 * settings; here the kind's own `JobRetryPolicy` does it, which is what
 * `job-queue.test.ts` holds equal to the deployed settings.
 *
 * A job out of attempts becomes `dead` rather than being dropped: that row,
 * with the error that ended it, is what the dead-letter queue holds on the
 * other host. Nothing consumes or sweeps it; it is there to be seen, and it
 * is counted in the health report. A completed job's row goes at once, so
 * the table grows only by what failed for good.
 *
 * Jobs run concurrently up to a bound, so a host coming back to a backlog
 * works through it a few at a time; the next ones start as soon as one
 * settles. Every claim is a lease, and when a lease runs out the poller lets
 * go of that delivery in both places at once: the row goes back to pending,
 * and the slot it held stops counting against the bound. A hung handler
 * therefore costs one lease, not a permanently narrower queue — and it
 * cannot corrupt the redelivery that replaces it, because settling is fenced
 * on the claim token it no longer owns.
 *
 * Polling, delivery and arming are total: a store that throws is logged and
 * the timer re-armed, never left as an unhandled rejection from a timer task.
 * The poller schedules itself only for the kinds it can actually claim, so a
 * job left for a newer build waits quietly instead of being polled for.
 */

import { JOB_KINDS, deliverJob, type Job, type JobDeps, type JobKind, type Jobs } from "../jobs";
import type { CorrelationContext, Logger } from "../logger";
import type { ClaimedJob, JobStore, JobStoreStats } from "./job-store";

/** The longest delay a single timer can hold; later jobs re-arm. */
const MAX_TIMER_DELAY_MS = 2 ** 31 - 1;
/** Jobs delivered at the same time, unless the host says otherwise. */
const DEFAULT_MAX_CONCURRENT_JOBS = 8;
/**
 * How long a claim holds a job before it may be delivered again. Comfortably
 * longer than the slowest handler's own deadline — the image-build finalizer
 * bounds a provider attempt at five minutes and holds its store lease for
 * six — so a live delivery is never overtaken, while a host that died or a
 * handler that hung frees the job within the quarter hour.
 */
export const JOB_CLAIM_LEASE_MS = 15 * 60 * 1000;
/** How often expired leases are swept when nothing else wakes the timer. */
export const LEASE_SWEEP_INTERVAL_MS = 60 * 1000;
/** The clock source, unless a test supplies one; read per call so fake timers apply. */
const DEFAULT_NOW = (): number => Date.now();
/** How job ids are minted, unless a test supplies its own. */
const DEFAULT_NEW_ID = (): string => crypto.randomUUID();

export interface NodeJobsOptions {
  store: JobStore;
  /**
   * What a delivery is given, minus the correlation this host mints per job.
   * A thunk because the deps hold the host's `Env`, which holds this queue:
   * the record does not exist yet when the queue is constructed.
   */
  deps: () => Omit<JobDeps, "correlation">;
  log: Logger;
  now?: () => number;
  /** How many jobs may be delivered at once. */
  maxConcurrentJobs?: number;
  /** Mints job ids; the default is a random uuid. */
  newId?: () => string;
}

export class NodeJobs implements Jobs {
  private readonly store: JobStore;
  private readonly deps: () => Omit<JobDeps, "correlation">;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly maxConcurrentJobs: number;
  private readonly newId: () => string;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  /** Deliveries this process started, by job id, with the lease each holds. */
  private readonly inFlight = new Map<string, { delivery: Promise<void>; leaseUntil: number }>();

  constructor(options: NodeJobsOptions) {
    this.store = options.store;
    this.deps = options.deps;
    this.log = options.log;
    this.now = options.now ?? DEFAULT_NOW;
    this.maxConcurrentJobs = options.maxConcurrentJobs ?? DEFAULT_MAX_CONCURRENT_JOBS;
    this.newId = options.newId ?? DEFAULT_NEW_ID;
  }

  /**
   * Record the job, runnable at once. Resolves when the row is written: that
   * is what makes it durable, exactly as a Queue send does on Cloudflare.
   * The write is synchronous, and `async` is what turns a failed one into a
   * rejection rather than a throw the Cloudflare adapter would never produce.
   */
  async send(job: Job): Promise<void> {
    const now = this.now();
    this.store.add(
      { id: this.newId(), kind: job.kind, payload: JSON.stringify(job.payload), runAt: now },
      now
    );
    this.arm();
  }

  /**
   * Start delivering. Idempotent: recovery takes only claims whose lease has
   * run out, so starting again never takes a job away from a delivery that
   * is still running.
   */
  start(): void {
    this.running = true;
    this.arm();
  }

  /** Stop claiming. Jobs already running are not interrupted. */
  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Resolves once every delivery still counted has settled. A delivery whose
   * lease has run out is not among them: the poller has already let go of it.
   */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.delivery));
  }

  /** What the table holds right now. */
  stats(): JobStoreStats {
    return this.store.stats(this.now());
  }

  /**
   * Wake at the soonest of: the next runnable job, and the next lease sweep.
   * At capacity only the sweep is armed — a settling delivery re-arms for
   * the rest, and expired leases still have to be reclaimed meanwhile.
   */
  private arm(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;
    const now = this.now();
    let wakeAt = now + LEASE_SWEEP_INTERVAL_MS;
    if (this.inFlight.size < this.maxConcurrentJobs) {
      try {
        const next = this.store.earliest(KNOWN_KINDS);
        if (next !== null) wakeAt = Math.min(wakeAt, next);
      } catch (error) {
        // Arming ends every path — a send, a tick, a settling delivery — so a
        // throw here would reject a send whose row is already durable, or
        // escape a timer task and take the process with it. The sweep
        // interval is the fallback: the host keeps waking, just without
        // knowing what is due until the store answers again.
        this.log.error("Jobs poller could not schedule its next wake-up", {
          event: "jobs.arm_failed",
          error_message: message(error),
        });
      }
    }
    const delay = Math.min(Math.max(0, wakeAt - now), MAX_TIMER_DELAY_MS);
    this.timer = setTimeout(() => this.tick(), delay);
  }

  /** One wake-up. Total: nothing here may reject out of the timer task. */
  private tick(): void {
    this.timer = null;
    try {
      this.forgetExpiredDeliveries();
      this.recoverExpiredClaims();
      this.claimAndRun();
    } catch (error) {
      // The store is unusable for now. Keep the timer alive so the host
      // recovers on its own if the failure was transient.
      this.log.error("Jobs poller failed to claim work", {
        event: "jobs.poll_failed",
        error_message: message(error),
      });
    }
    this.arm();
  }

  /**
   * Stop counting deliveries whose lease has run out. The promise itself
   * cannot be cancelled, so it is simply no longer ours: whatever it does
   * later is fenced by a claim token the row no longer carries.
   */
  private forgetExpiredDeliveries(): void {
    const now = this.now();
    const abandoned: string[] = [];
    for (const [id, entry] of this.inFlight) {
      if (entry.leaseUntil > now) continue;
      this.inFlight.delete(id);
      abandoned.push(id);
    }
    if (abandoned.length === 0) return;
    this.log.error("Job deliveries outlived their lease and were abandoned", {
      event: "jobs.delivery_abandoned",
      job_ids: abandoned,
    });
  }

  private recoverExpiredClaims(): void {
    const recovered = this.store.recoverExpiredClaims(this.now());
    if (recovered.length === 0) return;
    this.log.warn("Returning jobs whose claim expired", {
      event: "jobs.claims_recovered",
      job_ids: recovered,
    });
  }

  private claimAndRun(): void {
    const capacity = this.maxConcurrentJobs - this.inFlight.size;
    if (capacity <= 0) return;
    const now = this.now();
    const leaseUntil = now + JOB_CLAIM_LEASE_MS;
    for (const job of this.store.claim(now, capacity, KNOWN_KINDS, leaseUntil)) {
      // Registered before the delivery starts, so a job it sends is left to
      // the next wake-up rather than counted against this tick's capacity.
      const delivery = Promise.resolve()
        .then(() => this.deliver(job))
        .catch((error: unknown) => {
          // Settling failed, so the row is still leased; it comes back when
          // the lease runs out rather than being lost here.
          this.log.error("Job delivery could not be settled", {
            event: "jobs.settle_failed",
            job_id: job.id,
            job_kind: job.kind,
            error_message: message(error),
          });
        })
        .finally(() => {
          // Only if this delivery is still the one being counted: an
          // abandoned delivery must not evict the one that replaced it.
          if (this.inFlight.get(job.id)?.delivery === delivery) this.inFlight.delete(job.id);
          this.arm();
        });
      this.inFlight.set(job.id, { delivery, leaseUntil });
    }
  }

  private async deliver(job: ClaimedJob): Promise<void> {
    const kind = job.kind as JobKind;
    const { retry } = JOB_KINDS[kind];
    // Only a recovered claim can arrive over budget: the settlement below
    // buries a job that spends its last attempt, so the normal path never
    // hands one back. Running it again would break the parity with
    // Cloudflare, which stops after `max_retries`.
    if (job.attempts > retry.maxAttempts) {
      this.bury(job, "Attempts were exhausted before this delivery");
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(job.payload);
    } catch (error) {
      // The stored text is this host's own encoding, so this is corruption
      // rather than a poison message. It still follows the retry policy, so
      // it ends in the dead-letter rows instead of vanishing.
      this.failed(
        job,
        retry.maxAttempts,
        retry.retryDelayMs,
        `Unreadable payload: ${message(error)}`
      );
      return;
    }

    const correlation: CorrelationContext = { trace_id: job.id, request_id: job.id };
    const outcome = await deliverJob(kind, payload, job.attempts, { ...this.deps(), correlation });
    if (outcome === "ack") {
      this.store.complete(job.id, job.token);
      return;
    }
    this.failed(
      job,
      retry.maxAttempts,
      outcome.delayMs ?? retry.retryDelayMs,
      "The handler asked for a retry"
    );
  }

  /** Run the job again after `delayMs`, or bury it if that was its last attempt. */
  private failed(job: ClaimedJob, maxAttempts: number, delayMs: number, error: string): void {
    if (job.attempts >= maxAttempts) {
      this.bury(job, error);
      return;
    }
    this.store.retry(job.id, job.token, this.now() + delayMs);
  }

  /** Keep the row, with what ended it, where a dead-letter queue would hold it. */
  private bury(job: ClaimedJob, error: string): void {
    this.store.bury(job.id, job.token, error);
    this.log.error("Job will not be delivered again", {
      event: "jobs.dead",
      job_id: job.id,
      job_kind: job.kind,
      attempts: job.attempts,
      error_message: error,
    });
  }
}

/** The kinds this build can deliver; a row of any other kind is left alone. */
const KNOWN_KINDS: readonly string[] = Object.keys(JOB_KINDS);

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
