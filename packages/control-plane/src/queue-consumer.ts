import { consumeImageBuildFinalizations } from "./image-builds/finalization-consumer";
import {
  consumeSessionCallbacks,
  SESSION_CALLBACK_QUEUE_NAME_PREFIX,
} from "./session/callback-job-consumer";
import type { Env } from "./types";

export function consumeControlPlaneQueue(
  batch: MessageBatch<unknown>,
  env: Env,
  _ctx: ExecutionContext
): Promise<void> {
  return batch.queue.startsWith(SESSION_CALLBACK_QUEUE_NAME_PREFIX)
    ? consumeSessionCallbacks(batch, env)
    : consumeImageBuildFinalizations(batch, env);
}
