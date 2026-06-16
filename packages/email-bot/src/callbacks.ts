import { computeHmacHex, timingSafeEqual } from "@open-inspect/shared";
import { Hono } from "hono";
import type { CompletionCallback, Env, ToolCallCallback } from "./types";
import { replyToMessage } from "./agentmail";
import { buildEmailReply, extractAgentResponse } from "./completion";
import { createLogger } from "./logger";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isValidEmailContext(context: unknown): boolean {
  return (
    isRecord(context) &&
    context.source === "email" &&
    typeof context.inboxId === "string" &&
    typeof context.threadId === "string" &&
    typeof context.messageId === "string" &&
    typeof context.requestId === "string"
  );
}

function isValidCompletionPayload(payload: unknown): payload is CompletionCallback {
  return (
    isRecord(payload) &&
    typeof payload.sessionId === "string" &&
    typeof payload.messageId === "string" &&
    typeof payload.success === "boolean" &&
    typeof payload.timestamp === "number" &&
    typeof payload.signature === "string" &&
    isValidEmailContext(payload.context)
  );
}

function isValidToolCallPayload(payload: unknown): payload is ToolCallCallback {
  return (
    isRecord(payload) &&
    typeof payload.sessionId === "string" &&
    typeof payload.tool === "string" &&
    isRecord(payload.args) &&
    typeof payload.callId === "string" &&
    typeof payload.timestamp === "number" &&
    typeof payload.signature === "string" &&
    isValidEmailContext(payload.context)
  );
}

async function verifyCallbackSignature<T extends { signature: string }>(
  payload: T,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const expectedHex = await computeHmacHex(JSON.stringify(data), secret);
  return timingSafeEqual(signature, expectedHex);
}

export const callbacksRouter = new Hono<{ Bindings: Env }>();

callbacksRouter.post("/complete", async (c) => {
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const log = createLogger("callbacks", c.env.LOG_LEVEL);
  const payload: unknown = await c.req.json();

  if (!isValidCompletionPayload(payload)) {
    log.warn("callback.complete.rejected", { trace_id: traceId, reason: "invalid_payload" });
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    return c.json({ error: "callback secret not configured" }, 500);
  }

  const valid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!valid) return c.json({ error: "unauthorized" }, 401);

  c.executionCtx.waitUntil(handleCompletionCallback(payload, c.env, traceId));
  return c.json({ ok: true });
});

callbacksRouter.post("/tool_call", async (c) => {
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const log = createLogger("callbacks", c.env.LOG_LEVEL);
  const payload: unknown = await c.req.json();

  if (!isValidToolCallPayload(payload)) {
    log.warn("callback.tool_call.rejected", { trace_id: traceId, reason: "invalid_payload" });
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    return c.json({ error: "callback secret not configured" }, 500);
  }

  const valid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!valid) return c.json({ error: "unauthorized" }, 401);

  log.debug("callback.tool_call.skipped", {
    trace_id: traceId,
    session_id: payload.sessionId,
    tool: payload.tool,
    reason: "email_has_no_progress_surface",
  });
  return c.json({ ok: true, skipped: true });
});

async function handleCompletionCallback(
  payload: CompletionCallback,
  env: Env,
  traceId: string
): Promise<void> {
  const log = createLogger("callbacks", env.LOG_LEVEL);
  const { context } = payload;

  try {
    const agentResponse = await extractAgentResponse(
      env,
      payload.sessionId,
      payload.messageId,
      traceId
    );
    agentResponse.error = agentResponse.error || payload.error;
    const text = buildEmailReply({
      sessionId: payload.sessionId,
      webAppUrl: env.WEB_APP_URL,
      success: payload.success,
      agentResponse,
      error: agentResponse.error || payload.error,
    });

    await replyToMessage({
      env,
      inboxId: context.inboxId,
      messageId: context.messageId,
      text,
      labels: ["taskark-agent-response"],
    });

    log.info("callback.complete.replied", {
      trace_id: traceId,
      session_id: payload.sessionId,
      request_id: context.requestId,
      inbox_id: context.inboxId,
      thread_id: context.threadId,
    });
  } catch (error) {
    log.error("callback.complete.failed", {
      trace_id: traceId,
      session_id: payload.sessionId,
      request_id: context.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
