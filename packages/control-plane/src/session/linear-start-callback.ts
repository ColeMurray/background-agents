import { computeHmacHex } from "@open-inspect/shared";
import type { Logger } from "../logger";
import { deliverWithRetry } from "./callback-delivery";

interface LinearStartCallbackOptions {
  messageId: string;
  callbackContext: string;
  sessionId: string;
  secret: string;
  binding: Fetcher;
  log: Logger;
  sleep: (ms: number) => Promise<void>;
}

export async function notifyLinearStarted({
  messageId,
  callbackContext,
  sessionId,
  secret,
  binding,
  log,
  sleep,
}: LinearStartCallbackOptions): Promise<void> {
  let context: unknown;
  try {
    context = JSON.parse(callbackContext);
  } catch {
    context = null;
  }
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    log.warn("callback.started", {
      message_id: messageId,
      outcome: "skipped",
      skip_reason: "invalid_callback_context",
    });
    return;
  }

  const payloadData = { sessionId, messageId, timestamp: Date.now(), context };
  const payload = {
    ...payloadData,
    signature: await computeHmacHex(JSON.stringify(payloadData), secret),
  };

  const delivered = await deliverWithRetry(
    (signal) =>
      binding.fetch("https://internal/callbacks/start", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal,
      }),
    sleep,
    (failure) => {
      log.warn("callback.started", {
        message_id: messageId,
        outcome: "error",
        attempt: failure.attempt,
        ...(failure.response
          ? { http_status: failure.response.status }
          : {
              error:
                failure.error instanceof Error ? failure.error : new Error(String(failure.error)),
            }),
      });
    }
  );

  if (delivered) {
    log.info("callback.started", { message_id: messageId, outcome: "success" });
    return;
  }
  log.error("callback.started", { message_id: messageId, outcome: "failed" });
}
