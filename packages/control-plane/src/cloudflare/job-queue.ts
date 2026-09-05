/**
 * Cloudflare's wiring of the jobs seam: one Queue per job kind.
 *
 * A message carries the job's payload alone, exactly as it did before the
 * seam existed. A queue holds messages across a deploy, and the autofix
 * producer is a different Worker on its own release cycle, so the wire shape
 * is not ours to restate; the kind is recovered from the queue a message
 * arrived on rather than read out of its body.
 */

import { JOBS, type Job, type JobDeps, type JobKind, type JobQueue } from "../jobs";
import type { ImageBuildFinalizationJob } from "../image-builds/finalization-job";

/** Queue names Terraform derives from the deployment name. */
const AUTOFIX_QUEUE_NAME_PREFIX = "open-inspect-github-autofix-";

/** The Queue bindings the producible kinds are sent on. */
export interface JobQueueBindings {
  IMAGE_BUILD_FINALIZATION_QUEUE: Queue<ImageBuildFinalizationJob>;
}

/**
 * The kind delivered on `queueName`. Only the finalization and autofix queues
 * have a consumer bound (their dead-letter queues have none), so the autofix
 * prefix decides and every other name is a finalization — including the one
 * the integration tests deliver on.
 */
export function jobKindForQueue(queueName: string): JobKind {
  return queueName.startsWith(AUTOFIX_QUEUE_NAME_PREFIX)
    ? "github.autofix"
    : "image_build.finalize";
}

export function createCloudflareJobQueue(bindings: JobQueueBindings): JobQueue {
  const queues: { [K in Job["kind"]]: Queue<Extract<Job, { kind: K }>["payload"]> } = {
    "image_build.finalize": bindings.IMAGE_BUILD_FINALIZATION_QUEUE,
  };
  return {
    async send(job: Job): Promise<void> {
      await queues[job.kind].send(job.payload);
    },
  };
}

/**
 * Runs one batch: the queue picks the kind, and each message's outcome maps
 * onto its own ack or retry so one failure does not hold up the rest.
 */
export async function consumeJobBatch(batch: MessageBatch<unknown>, deps: JobDeps): Promise<void> {
  const definition = JOBS[jobKindForQueue(batch.queue)];
  const consumer = definition.consumer(deps);

  for (const message of batch.messages) {
    const outcome = await consumer.run(message.body, {
      id: message.id,
      attempts: message.attempts,
      maxAttempts: definition.maxAttempts,
    });
    if (outcome === "ack") {
      message.ack();
    } else if (outcome === "retry") {
      message.retry({ delaySeconds: definition.retryDelaySeconds });
    } else {
      message.retry({ delaySeconds: outcome.delaySeconds });
    }
  }
}
