import type { Env } from "../types";
import { createLogger } from "../logger";
import { processSlackCompletion } from "./delivery";
import { slackCompletionJobSchema } from "./job";

const log = createLogger("completion-consumer");

export async function consumeSlackCompletions(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = slackCompletionJobSchema.safeParse(message.body);
    if (!parsed.success) {
      log.error("slack.completion.job_invalid", {
        queue_message_id: message.id,
        attempts: message.attempts,
        outcome: "rejected",
      });
      message.ack();
      continue;
    }

    try {
      const result = await processSlackCompletion(parsed.data, env);
      if (result?.kind === "retry") {
        message.retry();
        continue;
      }
    } catch (error) {
      log.error("slack.completion.unhandled", {
        delivery_id: parsed.data.deliveryId,
        queue_message_id: message.id,
        attempts: message.attempts,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
    // An unhandled failure has unknown publication state. Only an explicit safe result permits replay.
    message.ack();
  }
}
