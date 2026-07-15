import { computeHmacHex } from "@open-inspect/shared";
import type { Logger } from "../logger";
import { deliverWithRetry } from "./callback-delivery";

interface LinearStartCallbackOptions {
  messageId: string;
  callbackContext: string;
  traceId: string | null;
  sessionId: string;
  secret: string;
  binding: Fetcher;
  log: Logger;
  sleep: (ms: number) => Promise<void>;
}

interface StartCallbackDeliverySummary {
  outcome: "success" | "error" | "rejected";
  attempts: number;
  httpStatus?: number;
  rejectReason?: string;
  error?: unknown;
  rethrow?: boolean;
}

async function deliverLinearStarted({
  messageId,
  callbackContext,
  traceId,
  sessionId,
  secret,
  binding,
  log,
  sleep,
}: LinearStartCallbackOptions): Promise<StartCallbackDeliverySummary> {
  try {
    let context: unknown;
    try {
      context = JSON.parse(callbackContext);
    } catch {
      context = null;
    }
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      return {
        outcome: "rejected",
        attempts: 0,
        rejectReason: "invalid_callback_context",
      };
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
          headers: {
            "Content-Type": "application/json",
            ...(traceId ? { "x-trace-id": traceId } : {}),
          },
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
    return {
      outcome: result.delivered ? "success" : "error",
      attempts: result.attempts,
      httpStatus: result.httpStatus,
    };
  } catch (error) {
    return { outcome: "error", attempts: 0, error, rethrow: true };
  }
}

export async function notifyLinearStarted({
  messageId,
  callbackContext,
  traceId,
  sessionId,
  secret,
  binding,
  log,
  sleep,
}: LinearStartCallbackOptions): Promise<void> {
  const startedAt = Date.now();
  const summary = await deliverLinearStarted({
    messageId,
    callbackContext,
    traceId,
    sessionId,
    secret,
    binding,
    log,
    sleep,
  });
  const fields = {
    session_id: sessionId,
    message_id: messageId,
    outcome: summary.outcome,
    duration_ms: Date.now() - startedAt,
    attempts: summary.attempts,
    retries: Math.max(0, summary.attempts - 1),
    ...(summary.httpStatus !== undefined ? { http_status: summary.httpStatus } : {}),
    ...(summary.rejectReason ? { reject_reason: summary.rejectReason } : {}),
    ...(summary.error !== undefined
      ? {
          error: summary.error instanceof Error ? summary.error : new Error(String(summary.error)),
        }
      : {}),
  };
  if (summary.outcome === "error") log.error("callback.started_delivery", fields);
  else log.info("callback.started_delivery", fields);

  if (summary.rethrow) throw summary.error;
}
