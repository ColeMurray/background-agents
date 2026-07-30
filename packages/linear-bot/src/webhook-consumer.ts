import type { Env } from "./types";
import { createLogger } from "./logger";
import {
  claimDelivery,
  clearDeliveryClaim,
  deleteExpiredDeliveries,
  markDeliveryFailed,
  markDeliveryProcessed,
} from "./delivery-store";
import { handleAgentSessionEvent } from "./webhook-handler";
import { linearWebhookJobSchema } from "./webhook-job";

const log = createLogger("webhook-consumer");
const MAX_PROCESSING_ATTEMPTS = 4;
const PROCESSING_RETRY_DELAY_SECONDS = 60;

export async function consumeLinearWebhooks(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = linearWebhookJobSchema.safeParse(message.body);
    if (!parsed.success) {
      log.error("webhook.queue_job_invalid", {
        queue_message_id: message.id,
        attempts: message.attempts,
        outcome: "terminal",
      });
      message.ack();
      continue;
    }

    const job = parsed.data;
    try {
      await deleteExpiredDeliveries(env).catch((error) => {
        log.warn("webhook.delivery_cleanup_failed", {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      });
      const claim = await claimDelivery(env, job.deliveryId, message.id);
      if (claim === "processed" || claim === "failed") {
        log.info("webhook.deduplicated", {
          trace_id: job.traceId,
          event_key: job.deliveryId,
          queue_message_id: message.id,
        });
        message.ack();
        continue;
      }
      if (claim === "processing") {
        const terminal = message.attempts >= MAX_PROCESSING_ATTEMPTS;
        log.error("webhook.delivery_claim_unavailable", {
          trace_id: job.traceId,
          event_key: job.deliveryId,
          queue_message_id: message.id,
          attempts: message.attempts,
          outcome: terminal ? "terminal" : "retrying",
        });
        if (terminal) message.ack();
        else message.retry({ delaySeconds: PROCESSING_RETRY_DELAY_SECONDS });
        continue;
      }

      await handleAgentSessionEvent(job.payload, env, job.traceId, job.deliveryId);
      await markDeliveryProcessed(env, job.deliveryId, message.id);
      message.ack();
    } catch (error) {
      const terminal = message.attempts >= MAX_PROCESSING_ATTEMPTS;
      let markerCleared = false;
      if (terminal) {
        await markDeliveryFailed(env, job.deliveryId, message.id).catch((terminalError) => {
          log.error("webhook.terminal_marker_failed", {
            trace_id: job.traceId,
            event_key: job.deliveryId,
            error:
              terminalError instanceof Error ? terminalError : new Error(String(terminalError)),
          });
        });
      } else {
        try {
          await clearDeliveryClaim(env, job.deliveryId, message.id);
          markerCleared = true;
        } catch (clearError) {
          log.error("webhook.processing_marker_clear_failed", {
            trace_id: job.traceId,
            event_key: job.deliveryId,
            queue_message_id: message.id,
            attempts: message.attempts,
            error: clearError instanceof Error ? clearError : new Error(String(clearError)),
          });
        }
      }
      log.error("webhook.processing_failed", {
        trace_id: job.traceId,
        event_key: job.deliveryId,
        queue_message_id: message.id,
        attempts: message.attempts,
        marker_cleared: markerCleared,
        outcome: terminal ? "terminal" : "retrying",
        error: error instanceof Error ? error : new Error(String(error)),
      });
      if (terminal) message.ack();
      else message.retry();
    }
  }
}
