/**
 * The control plane's background jobs: work one request hands off so that a
 * consumer runs it later, once, durably. `scheduled-jobs.ts` is the clock's
 * table; this is the queue's.
 *
 * Cloudflare delivers a job as a Queue message, one queue per kind, and
 * `cloudflare/job-queue.ts` maps between the two. A container has no queue
 * service: it writes a row and polls it. Neither host appears below — a
 * definition names its kind, its delivery policy and how to run one delivery,
 * which is all either host needs to drive it.
 *
 * A body reaching a consumer has crossed a durable medium and may predate the
 * code reading it, so `Job` types the send side and `unknown` is what the
 * receive side is honestly given: a consumer validates before it acts.
 */

import { createAutofixConsumer } from "./autofix/handler";
import type { SqlDatabase } from "./db/sql-database";
import { createImageBuildFinalizationConsumer } from "./image-builds/finalization-consumer";
import type { ImageBuildFinalizationJob } from "./image-builds/finalization-job";
import { IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS } from "./image-builds/finalizer";
import type { Env } from "./types";

/** Every kind of background job this worker runs. */
export type JobKind = "image_build.finalize" | "github.autofix";

/**
 * A job the control plane produces. `github.autofix` is absent on purpose:
 * the github-bot worker produces those and this one only runs them, so the
 * kind appears in `JOBS` below but never in a `send`.
 */
export type Job = { kind: "image_build.finalize"; payload: ImageBuildFinalizationJob };

/** Hands a job off to run later; resolves once the job is durable. */
export interface JobQueue {
  send(job: Job): Promise<void>;
}

/** One attempt at running one job. */
export interface JobDelivery {
  /** Identifies the job in logs, and is the same across its deliveries. */
  readonly id: string;
  /** 1 on the first delivery. */
  readonly attempts: number;
  /** The kind's `maxAttempts`, so a consumer can recognise its last chance. */
  readonly maxAttempts: number;
}

/** What a consumer decides about one delivery. */
export type JobOutcome =
  /** Done with this job, successfully or not; do not redeliver. */
  | "ack"
  /** Redeliver after the kind's `retryDelaySeconds`. */
  | "retry"
  /** Redeliver after a delay this delivery chose. */
  | { retry: true; delaySeconds: number };

/**
 * What building a consumer is given; the host builds it per batch or poll.
 * `db` is the global store the host already opened, passed rather than read
 * off `env` so that consumers stay out of the composition root, exactly as
 * `ScheduledJobDeps` does for the clock.
 */
export interface JobDeps {
  env: Env;
  db: SqlDatabase;
}

/** Runs deliveries of one kind. */
export interface JobConsumer {
  run(body: unknown, delivery: JobDelivery): Promise<JobOutcome>;
}

export interface JobDefinition {
  readonly kind: JobKind;
  /**
   * Deliveries after which the host stops redelivering and the job is dead.
   * Cloudflare enforces this from the queue consumer's `max_retries`; a
   * poller enforces it from here. `jobs.test.ts` holds the two equal.
   */
  readonly maxAttempts: number;
  /** How long a plain `"retry"` waits. Mirrors the consumer's `retry_delay`. */
  readonly retryDelaySeconds: number;
  /**
   * Build the consumer for one batch or poll. Two steps rather than one call
   * so that a batch shares the service graph its deliveries need instead of
   * rebuilding it per message.
   */
  consumer(deps: JobDeps): JobConsumer;
}

export const JOBS = {
  "image_build.finalize": {
    kind: "image_build.finalize",
    // Terraform: max_retries = 12, retry_delay = 15.
    maxAttempts: 13,
    retryDelaySeconds: IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS,
    consumer: createImageBuildFinalizationConsumer,
  },
  "github.autofix": {
    kind: "github.autofix",
    // Terraform: max_retries = 4, retry_delay = 30.
    maxAttempts: 5,
    retryDelaySeconds: 30,
    consumer: createAutofixConsumer,
  },
} as const satisfies { [K in JobKind]: JobDefinition & { kind: K } };

/** The definition for a kind read back off the wire, where it is a string. */
export function findJob(kind: string): JobDefinition | undefined {
  return Object.hasOwn(JOBS, kind) ? JOBS[kind as JobKind] : undefined;
}
