/**
 * The control plane's background jobs: one table that every host delivers
 * from. A producer calls `env.JOBS.send(job)`, and the job is durable before
 * `send` resolves. A host later hands the payload back to its kind's
 * handler, with the delivery count, and the handler answers `"ack"` or asks
 * for a retry. Nothing outside the hosts' adapters sees a queue.
 *
 * On Cloudflare each kind is a Queue (`cloudflare/job-queue.ts`) whose
 * consumer Terraform declares with the retry settings below; a unit test
 * holds the two equal. A future Node jobs table and poller can deliver the
 * same registry; until then that host exposes JOBS as null.
 *
 * Retry taxonomy. Delivery is at-least-once on every host, so a handler
 * must tolerate a duplicate: image-build finalization is fenced by a store
 * lease and a completion hash, and the autofix ledger is keyed by the
 * provider object. Both kinds retry on failure until `maxAttempts`, then
 * dead-letter. A payload that does not parse, or a handler that throws, is
 * retried on the same terms rather than dropped: a poison message ends in
 * the dead-letter queue, where an operator (and, for autofix, the queue
 * health check) can see it.
 */

import { githubAutofixEnvelopeSchema, type GitHubAutofixEnvelope } from "@open-inspect/shared";
import type { z } from "zod";
import { handleAutofixJob } from "./autofix/handler";
import type { SqlDatabase } from "./db/sql-database";
import { handleImageBuildFinalization } from "./image-builds/finalization-consumer";
import {
  imageBuildFinalizationJobSchema,
  type ImageBuildFinalizationJob,
} from "./image-builds/finalization-job";
import { IMAGE_BUILD_FINALIZATION_RETRY_DELAY_MS } from "./image-builds/finalizer";
import type { CorrelationContext, Logger } from "./logger";
import type { Env } from "./types";

/** How a host redelivers a kind's failed jobs. */
export interface JobRetryPolicy {
  /** Deliveries a job gets in total, the first included; the host dead-letters it after the last. */
  maxAttempts: number;
  /** Milliseconds a retry waits when the handler names no delay of its own. */
  retryDelayMs: number;
}

/** What the host knows about one delivery. */
export interface JobDelivery {
  /** This delivery's ordinal, starting at 1. */
  attempts: number;
  /** The kind's `maxAttempts`, so a handler can tell the last delivery. */
  maxAttempts: number;
}

/** What one delivery is given. The host builds it per delivery. */
export interface JobDeps {
  env: Env;
  db: SqlDatabase;
  log: Logger;
  /** Identifies this delivery in logs; the host mints one per delivery. */
  correlation: CorrelationContext;
}

/**
 * A handler's answer. `"ack"` retires the job. A retry redelivers it after
 * `delayMs`, or after the kind's `retryDelayMs` when unset; the
 * host dead-letters it instead once `maxAttempts` is spent.
 */
export type JobOutcome = "ack" | { retry: true; delayMs?: number };

interface JobKindDefinition<Payload> {
  /** The wire shape of the payload; a host parses every delivery with it. */
  payload: z.ZodType<Payload>;
  retry: JobRetryPolicy;
  handle(payload: Payload, delivery: JobDelivery, deps: JobDeps): Promise<JobOutcome>;
}

function defineJobKind<Payload>(
  definition: JobKindDefinition<Payload>
): JobKindDefinition<Payload> {
  return definition;
}

export const JOB_KINDS = {
  /**
   * Finalize an accepted image build: snapshot the provider session and
   * publish the ready image. Retried while the build's lease is held
   * elsewhere and on provider failure; the completion hash makes a
   * duplicate a no-op.
   */
  "image_build.finalize": defineJobKind<ImageBuildFinalizationJob>({
    payload: imageBuildFinalizationJobSchema,
    retry: { maxAttempts: 13, retryDelayMs: IMAGE_BUILD_FINALIZATION_RETRY_DELAY_MS },
    handle: handleImageBuildFinalization,
  }),
  /**
   * Turn PR feedback the GitHub bot received into a session prompt. Retried
   * on transient provider failure; the handler records the last failed
   * delivery in the ledger before the host dead-letters it.
   */
  "github.autofix": defineJobKind<GitHubAutofixEnvelope>({
    payload: githubAutofixEnvelopeSchema,
    retry: { maxAttempts: 5, retryDelayMs: 30_000 },
    handle: handleAutofixJob,
  }),
};

export type JobKind = keyof typeof JOB_KINDS;

export type JobPayload<K extends JobKind> = z.infer<(typeof JOB_KINDS)[K]["payload"]>;

/** A job as a producer sends it: its kind and the payload that kind carries. */
export type Job = { [K in JobKind]: { kind: K; payload: JobPayload<K> } }[JobKind];

/** The port a producer holds. Resolves once the job is durable, before delivery begins. */
export interface Jobs {
  send(job: Job): Promise<void>;
}

/**
 * Deliver one payload of `kind` as the host received it: parse it, run the
 * kind's handler, and answer for what the handler could not. A payload that
 * does not parse and a handler that throws are both logged and retried, so
 * they dead-letter after `maxAttempts` instead of vanishing.
 */
export async function deliverJob(
  kind: JobKind,
  payload: unknown,
  attempts: number,
  deps: JobDeps
): Promise<JobOutcome> {
  const definition: JobKindDefinition<unknown> = JOB_KINDS[kind];
  const delivery: JobDelivery = { attempts, maxAttempts: definition.retry.maxAttempts };
  const context = {
    job_kind: kind,
    attempts,
    max_attempts: delivery.maxAttempts,
    request_id: deps.correlation.request_id,
    trace_id: deps.correlation.trace_id,
  };

  const parsed = definition.payload.safeParse(payload);
  if (!parsed.success) {
    deps.log.error("job.payload_invalid", { ...context, issues: parsed.error.issues });
    return { retry: true };
  }

  try {
    return await definition.handle(parsed.data, delivery, deps);
  } catch (error) {
    deps.log.error("job.handler_failed", {
      ...context,
      error: error instanceof Error ? error : new Error(String(error)),
    });
    return { retry: true };
  }
}
