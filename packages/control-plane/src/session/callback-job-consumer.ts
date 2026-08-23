import { computeHmacHex } from "@open-inspect/shared/auth";
import {
  sessionCallbackJobSchema,
  type SessionCallbackJob,
} from "@open-inspect/shared/types/session-callback-jobs";
import {
  linearCompletionCallbackPayloadSchema,
  linearToolCallCallbackPayloadSchema,
} from "@open-inspect/shared/types/session-api";
import { callbackSigningSecret, type CallbackDestination } from "../auth/service/callback-signing";
import { createLogger } from "../logger";
import type { Env } from "../types";

export const SESSION_CALLBACK_QUEUE_NAME_PREFIX = "open-inspect-session-callback-";
export const SESSION_CALLBACK_RETRY_DELAY_SECONDS = 15;
const CALLBACK_ATTEMPT_TIMEOUT_MS = 10_000;
const logger = createLogger("session-callback-consumer");

type DeliveryResult =
  | { delivered: true; destination: CallbackDestination; httpStatus: number }
  | {
      delivered: false;
      destination: CallbackDestination;
      httpStatus?: number;
      rejectReason?: string;
      error?: unknown;
    };

type JobDelivery = (job: SessionCallbackJob) => Promise<DeliveryResult>;

function destinationFor(job: SessionCallbackJob): CallbackDestination {
  return job.type === "session.started" || job.payload.source === "linear"
    ? "linear-bot"
    : "slack-bot";
}

const CALLBACK_ENDPOINTS: Record<SessionCallbackJob["type"], string> = {
  "session.started": "/callbacks/start",
  "session.completed": "/callbacks/complete",
  tool_call: "/callbacks/tool_call",
};

function callbackPayload(job: SessionCallbackJob): Record<string, unknown> | null {
  if (job.type === "session.started") {
    return job.payload;
  }
  if (job.type === "session.completed") {
    const { source: _source, ...payload } = job.payload;
    if (job.payload.source === "linear") {
      const parsed = linearCompletionCallbackPayloadSchema.safeParse(payload);
      return parsed.success ? parsed.data : null;
    }
    return payload;
  }

  const { source: _source, messageId: _messageId, ...payload } = job.payload;
  if (job.payload.source === "linear") {
    const parsed = linearToolCallCallbackPayloadSchema.safeParse(payload);
    return parsed.success ? parsed.data : null;
  }
  return payload;
}

export async function deliverSessionCallbackJob(
  job: SessionCallbackJob,
  env: Pick<
    Env,
    "SLACK_BOT" | "LINEAR_BOT" | "SERVICE_AUTH_SECRET_SLACK_BOT" | "SERVICE_AUTH_SECRET_LINEAR_BOT"
  >
): Promise<DeliveryResult> {
  const destination = destinationFor(job);
  const binding = destination === "linear-bot" ? env.LINEAR_BOT : env.SLACK_BOT;
  const secret = callbackSigningSecret(env, destination);
  if (!binding || !secret) {
    return {
      delivered: false,
      destination,
      rejectReason: !binding ? "no_binding" : "no_secret",
    };
  }

  const payloadData = callbackPayload(job);
  if (!payloadData) {
    return { delivered: false, destination, rejectReason: "invalid_payload" };
  }
  const payload = {
    ...payloadData,
    signature: await computeHmacHex(JSON.stringify(payloadData), secret),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CALLBACK_ATTEMPT_TIMEOUT_MS);
  try {
    const response = await binding.fetch(`https://internal${CALLBACK_ENDPOINTS[job.type]}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (response.ok) {
      return { delivered: true, destination, httpStatus: response.status };
    }
    return { delivered: false, destination, httpStatus: response.status };
  } catch (error) {
    return { delivered: false, destination, error };
  } finally {
    clearTimeout(timeout);
  }
}

/** Applies durable retry policy: start/completion retry, cosmetic tool calls never do. */
export async function consumeSessionCallbackBatch(
  batch: MessageBatch<unknown>,
  deliver: JobDelivery
): Promise<void> {
  for (const message of batch.messages) {
    const parsed = sessionCallbackJobSchema.safeParse(message.body);
    if (!parsed.success) {
      logger.error("callback.job_invalid", {
        queue_message_id: message.id,
        attempts: message.attempts,
      });
      message.ack();
      continue;
    }

    let result: DeliveryResult;
    try {
      result = await deliver(parsed.data);
    } catch (error) {
      result = {
        delivered: false,
        destination: destinationFor(parsed.data),
        error,
      };
    }

    const fields = {
      queue_message_id: message.id,
      attempts: message.attempts,
      job_type: parsed.data.type,
      destination: result.destination,
      outcome: result.delivered ? "success" : "error",
      ...(result.httpStatus !== undefined ? { http_status: result.httpStatus } : {}),
      ...("rejectReason" in result && result.rejectReason
        ? { reject_reason: result.rejectReason }
        : {}),
      ...("error" in result && result.error !== undefined
        ? { error: result.error instanceof Error ? result.error : new Error(String(result.error)) }
        : {}),
    };
    if (result.delivered) logger.info("callback.delivery", fields);
    else logger.warn("callback.delivery", fields);

    if (result.delivered || parsed.data.type === "tool_call") {
      message.ack();
    } else {
      message.retry({ delaySeconds: SESSION_CALLBACK_RETRY_DELAY_SECONDS });
    }
  }
}

export async function consumeSessionCallbacks(
  batch: MessageBatch<unknown>,
  env: Env
): Promise<void> {
  await consumeSessionCallbackBatch(batch, (job) => deliverSessionCallbackJob(job, env));
}
