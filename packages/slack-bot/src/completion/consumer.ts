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
      await processSlackCompletion(parsed.data, env);
    } catch (error) {
      log.error("slack.completion.unhandled", {
        delivery_id: parsed.data.deliveryId,
        queue_message_id: message.id,
        attempts: message.attempts,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
    // Processing may already have produced Slack side effects. Retrying here can duplicate them.
    message.ack();
  }
}
