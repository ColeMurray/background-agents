import { ImageBuildStore } from "../db/image-builds";
import { createLogger } from "../logger";
import type { Env } from "../types";
import {
  IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS,
  ImageBuildFinalizer,
  type ImageBuildFinalizationResult,
} from "./finalizer";
import {
  imageBuildFinalizationJobSchema,
  type ImageBuildFinalizationJob,
} from "./finalization-job";
import { createImageBuildAdapterFactory } from "./provider-factory";

const logger = createLogger("image-builds:finalization-consumer");

type FinalizationProcessor = (
  job: ImageBuildFinalizationJob,
  requestId: string
) => Promise<ImageBuildFinalizationResult>;

/**
 * Applies Queue delivery semantics to one batch: invalid commands are
 * discarded, completed work is acknowledged, and busy or failed work is
 * retried without aborting later messages in the batch.
 */
export async function consumeImageBuildFinalizationBatch(
  batch: MessageBatch<unknown>,
  process: FinalizationProcessor
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = imageBuildFinalizationJobSchema.safeParse(message.body);
    if (!parsed.success) {
      logger.error("image_build.finalization_job_invalid", {
        queue_message_id: message.id,
        attempts: message.attempts,
      });
      message.ack();
      continue;
    }

    try {
      const result = await process(parsed.data, message.id);
      if (result.type === "retry") {
        message.retry({ delaySeconds: result.delaySeconds });
      } else {
        message.ack();
      }
    } catch (error) {
      logger.error("image_build.finalization_error", {
        build_id: parsed.data.buildId,
        queue_message_id: message.id,
        attempts: message.attempts,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      message.retry({ delaySeconds: IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS });
    }
  }
}

/** Cloudflare Queue composition root for the production finalizer. */
export async function consumeImageBuildFinalizations(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  // eslint-disable-next-line no-restricted-syntax -- Queue composition root: the one consumer env.DB read
  const db = env.DB;
  const finalizer = new ImageBuildFinalizer(
    new ImageBuildStore(db),
    createImageBuildAdapterFactory(env)
  );
  await consumeImageBuildFinalizationBatch(batch, (job, requestId) =>
    finalizer.process(job, { request_id: requestId, trace_id: requestId })
  );
}
