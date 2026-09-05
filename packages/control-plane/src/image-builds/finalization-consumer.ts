import { ImageBuildStore } from "../db/image-builds";
import type { JobConsumer, JobDeps } from "../jobs";
import { createLogger } from "../logger";
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
 * Applies delivery semantics to one finalization command: an invalid command
 * is discarded, completed work is acknowledged, and busy or failed work is
 * retried.
 */
export function imageBuildFinalizationConsumer(process: FinalizationProcessor): JobConsumer {
  return {
    async run(body, delivery) {
      const parsed = imageBuildFinalizationJobSchema.safeParse(body);
      if (!parsed.success) {
        logger.error("image_build.finalization_job_invalid", {
          job_id: delivery.id,
          attempts: delivery.attempts,
        });
        return "ack";
      }

      try {
        const result = await process(parsed.data, delivery.id);
        return result.type === "retry" ? { retry: true, delaySeconds: result.delaySeconds } : "ack";
      } catch (error) {
        logger.error("image_build.finalization_error", {
          build_id: parsed.data.buildId,
          job_id: delivery.id,
          attempts: delivery.attempts,
          error: error instanceof Error ? error : new Error(String(error)),
        });
        return { retry: true, delaySeconds: IMAGE_BUILD_FINALIZATION_RETRY_DELAY_SECONDS };
      }
    },
  };
}

/** Composition root for the production finalizer. */
export function createImageBuildFinalizationConsumer({ env, db }: JobDeps): JobConsumer {
  const finalizer = new ImageBuildFinalizer(
    new ImageBuildStore(db),
    createImageBuildAdapterFactory(env)
  );
  return imageBuildFinalizationConsumer((job, requestId) =>
    finalizer.process(job, { request_id: requestId, trace_id: requestId })
  );
}
