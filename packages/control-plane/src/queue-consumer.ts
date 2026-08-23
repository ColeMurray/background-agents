import { consumeImageBuildFinalizations } from "./image-builds/finalization-consumer";
import { IMAGE_BUILD_FINALIZATION_QUEUE_NAME_PREFIX } from "./image-builds/finalization-job";
import {
  consumeSessionCallbacks,
  SESSION_CALLBACK_QUEUE_NAME_PREFIX,
} from "./session/callback-job-consumer";
import type { Env } from "./types";

export async function consumeControlPlaneQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  if (batch.queue.startsWith(SESSION_CALLBACK_QUEUE_NAME_PREFIX)) {
    await consumeSessionCallbacks(batch, env);
    return;
  }
  if (batch.queue.startsWith(IMAGE_BUILD_FINALIZATION_QUEUE_NAME_PREFIX)) {
    await consumeImageBuildFinalizations(batch, env);
    return;
  }
  throw new Error(`Unsupported control-plane queue: ${batch.queue}`);
}
