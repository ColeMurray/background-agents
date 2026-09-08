/**
 * Internal endpoint the scheduler calls to render a triggering message's thread.
 *
 * Signed with the same in-body HMAC the completion callbacks use, so the Slack
 * token never leaves this worker. Failures answer 200 with an empty context
 * rather than an error status: thread history is an enhancement, and a run must
 * still start without it.
 */

import { verifyCallbackFromControlPlane } from "@open-inspect/shared/auth";
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "../types";
import { buildThreadContextForTrigger } from "../thread-context";
import { createLogger } from "../logger";

const log = createLogger("thread-context-route");

const threadContextRequestSchema = z.object({
  channel: z.string().min(1),
  threadTs: z.string().min(1).optional(),
  ts: z.string().min(1),
  signature: z.string().min(1),
});

export const threadContextRoutes = new Hono<{ Bindings: Env }>();

threadContextRoutes.post("/internal/thread-context", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }

  const parsed = threadContextRequestSchema.safeParse(payload);
  if (!parsed.success) {
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.SERVICE_AUTH_SECRET) {
    return c.json({ error: "not configured" }, 500);
  }
  if (!(await verifyCallbackFromControlPlane(parsed.data, c.env))) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/internal/thread-context",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  const { channel, threadTs, ts } = parsed.data;
  let threadContext = "";
  try {
    threadContext = await buildThreadContextForTrigger(c.env, { channel, threadTs, ts }, traceId);
  } catch (error) {
    // Never fail the caller: it launches with the plain context block instead.
    log.warn("slack.thread_context.build", {
      trace_id: traceId,
      channel,
      thread_ts: threadTs,
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }

  log.info("http.request", {
    trace_id: traceId,
    http_path: "/internal/thread-context",
    http_status: 200,
    channel,
    thread_ts: threadTs,
    has_context: threadContext.length > 0,
    duration_ms: Date.now() - startTime,
  });

  return c.json({ threadContext });
});
