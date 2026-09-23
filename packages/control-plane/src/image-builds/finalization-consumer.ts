import { ImageBuildStore } from "../db/image-builds";
import type { JobDelivery, JobDeps, JobOutcome } from "../jobs";
import type { ImageBuildFinalizationJob } from "./finalization-job";
import { ImageBuildFinalizer } from "./finalizer";
import { createImageBuildAdapterFactory } from "./provider-factory";

/**
 * Handler for `image_build.finalize`: the production finalizer over the
 * delivery's store. The finalizer decides between done and busy; a throw
 * is the host's to retry.
 *
 * One retry is not the host's to count. A provider artifact operation can
 * outlast a job's whole delivery budget — the budget is sized for lease
 * contention, not for a capture — so on the last delivery a pending operation
 * is republished as a fresh job instead. The operation's own fixed deadline,
 * written once when it was reserved, is what bounds the total wait; this only
 * keeps the poll alive until then. Every other retry spends the host's budget
 * as before and dead-letters when it runs out.
 */
export async function handleImageBuildFinalization(
  job: ImageBuildFinalizationJob,
  delivery: JobDelivery,
  deps: JobDeps
): Promise<JobOutcome> {
  const finalizer = new ImageBuildFinalizer(
    new ImageBuildStore(deps.db),
    createImageBuildAdapterFactory(deps.env)
  );
  const result = await finalizer.process(job, deps.correlation);
  if (result.type !== "retry") return "ack";

  if (result.reason === "pending_operation" && delivery.attempts >= delivery.maxAttempts) {
    await deps.env.JOBS.send(
      { kind: "image_build.finalize", payload: job },
      { delayMs: result.delayMs }
    );
    return "ack";
  }
  return { retry: true, delayMs: result.delayMs };
}
