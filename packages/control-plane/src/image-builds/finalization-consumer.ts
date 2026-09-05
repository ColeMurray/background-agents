import { ImageBuildStore } from "../db/image-builds";
import type { JobDelivery, JobDeps, JobOutcome } from "../jobs";
import type { ImageBuildFinalizationJob } from "./finalization-job";
import { ImageBuildFinalizer } from "./finalizer";
import { createImageBuildAdapterFactory } from "./provider-factory";

/**
 * Handler for `image_build.finalize`: the production finalizer over the
 * delivery's store. The finalizer decides between done and busy; a throw
 * is the host's to retry.
 */
export async function handleImageBuildFinalization(
  job: ImageBuildFinalizationJob,
  _delivery: JobDelivery,
  deps: JobDeps
): Promise<JobOutcome> {
  const finalizer = new ImageBuildFinalizer(
    new ImageBuildStore(deps.db),
    createImageBuildAdapterFactory(deps.env)
  );
  const result = await finalizer.process(job, deps.correlation);
  return result.type === "retry" ? { retry: true, delayMs: result.delayMs } : "ack";
}
