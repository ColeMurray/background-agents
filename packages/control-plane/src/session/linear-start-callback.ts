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
  const startedAt = Date.now();
  let context: unknown;
  let delivered = false;
  let attempts = 0;
  let httpStatus: number | undefined;
  let rejectReason: string | undefined;
  let thrownError: unknown;
  try {
    try {
      context = JSON.parse(callbackContext);
    } catch {
      context = null;
    }
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      rejectReason = "invalid_callback_context";
      return;
    }

    const payloadData = { sessionId, messageId, timestamp: Date.now(), context };
    const payload = {
      ...payloadData,
      signature: await computeHmacHex(JSON.stringify(payloadData), secret),
    };

    const result = await deliverWithRetry(
      (signal) =>
        binding.fetch("https://internal/callbacks/start", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal,
        }),
      sleep,
      (failure) => {
        log.warn("callback.started_delivery_attempt_failed", {
          session_id: sessionId,
          message_id: messageId,
          attempt: failure.attempt,
          ...(failure.response ? { http_status: failure.response.status } : {}),
          ...(failure.error !== undefined
            ? {
                error:
                  failure.error instanceof Error ? failure.error : new Error(String(failure.error)),
              }
            : {}),
        });
      }
    );
    delivered = result.delivered;
    attempts = result.attempts;
    httpStatus = result.httpStatus;
  } catch (error) {
    thrownError = error;
    throw error;
  } finally {
    const outcome =
      thrownError !== undefined
        ? "error"
        : rejectReason
          ? "rejected"
          : delivered
            ? "success"
            : "error";
    const fields = {
      session_id: sessionId,
      message_id: messageId,
      outcome,
      duration_ms: Date.now() - startedAt,
      attempts,
      retries: Math.max(0, attempts - 1),
      ...(httpStatus !== undefined ? { http_status: httpStatus } : {}),
      ...(rejectReason && thrownError === undefined ? { reject_reason: rejectReason } : {}),
      ...(thrownError !== undefined
        ? { error: thrownError instanceof Error ? thrownError : new Error(String(thrownError)) }
        : {}),
    };
    if (outcome === "error") log.error("callback.started_delivery", fields);
    else log.info("callback.started_delivery", fields);
  }
}
