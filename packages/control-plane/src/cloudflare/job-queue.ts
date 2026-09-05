/**
 * The jobs seam over Cloudflare Queues: one Queue per job kind. A message
 * carries the kind's payload alone, and the kind is recovered from the
 * queue it arrived on. That wire shape predates the seam and stays: a queue
 * holds messages across a deploy, and the autofix producer is a different
 * Worker on its own release cycle, so an envelope with the kind inside
 * would open a skew window for nothing.
 *
 * Terraform names each queue `<prefix>-<deployment>` and declares its
 * consumer's `max_retries` and `retry_delay`; `job-queue.test.ts` holds
 * those equal to the kind's `JobRetryPolicy`, so the two cannot drift.
 */

import { deliverJob, type JobDeps, type JobKind, type Jobs } from "../jobs";

/** The queue name prefix Terraform gives each kind's queue; the deployment name follows. */
export const JOB_QUEUE_PREFIXES: Record<JobKind, string> = {
  "image_build.finalize": "open-inspect-image-build-finalization",
  "github.autofix": "open-inspect-github-autofix",
};

/** The Worker's producer bindings, one per job kind; a kind whose queue the deployment omits is absent. */
export interface JobQueueBindings {
  IMAGE_BUILD_FINALIZATION_QUEUE: Queue<unknown>;
  AUTOFIX_QUEUE?: Queue<unknown>;
}

/** The producer binding Terraform gives the control-plane Worker for each kind's queue. */
export const JOB_QUEUE_BINDINGS: Record<JobKind, keyof JobQueueBindings> = {
  "image_build.finalize": "IMAGE_BUILD_FINALIZATION_QUEUE",
  "github.autofix": "AUTOFIX_QUEUE",
};

/** The kind delivered on `queueName`, or `undefined` for a queue no kind owns. */
export function jobKindForQueue(queueName: string): JobKind | undefined {
  return (Object.keys(JOB_QUEUE_PREFIXES) as JobKind[]).find((kind) =>
    queueName.startsWith(`${JOB_QUEUE_PREFIXES[kind]}-`)
  );
}

/** The producer side: `send` resolves once the Queue holds the payload. */
export function createQueueJobs(bindings: JobQueueBindings): Jobs {
  return {
    async send(job) {
      const queue = bindings[JOB_QUEUE_BINDINGS[job.kind]];
      if (!queue) {
        throw new Error(`No queue is bound for ${job.kind} jobs on this deployment`);
      }
      await queue.send(job.payload);
    },
  };
}

/** What the Worker gives every delivery in a batch; the correlation is minted per message. */
export type JobQueueHost = Omit<JobDeps, "correlation">;

/**
 * The consumer side: route the batch by its queue, deliver each message,
 * and map the outcome onto the message. A batch from a queue no kind owns
 * is retried whole so it dead-letters rather than disappears.
 */
export async function consumeJobBatch(
  batch: MessageBatch<unknown>,
  host: JobQueueHost
): Promise<void> {
  const kind = jobKindForQueue(batch.queue);
  if (!kind) {
    host.log.error("job.queue_unknown", {
      queue: batch.queue,
      known_prefixes: Object.values(JOB_QUEUE_PREFIXES),
      messages: batch.messages.length,
    });
    batch.retryAll();
    return;
  }

  for (const message of batch.messages) {
    const outcome = await deliverJob(kind, message.body, message.attempts, {
      ...host,
      correlation: { trace_id: message.id, request_id: message.id },
    });
    if (outcome === "ack") {
      message.ack();
    } else if (outcome.delaySeconds === undefined) {
      message.retry();
    } else {
      message.retry({ delaySeconds: outcome.delaySeconds });
    }
  }
}
