/**
 * Callback handlers for control-plane notifications.
 */

import { postEphemeral, verifyCallbackFromControlPlane } from "@open-inspect/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "./types";
import { createSlackCompletionJob, type SlackCompletionJob } from "./completion/job";
import { createLogger } from "./logger";
import { formatToolStatus, setAssistantThreadStatusBestEffort } from "./activity-status";

const log = createLogger("callback");

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

const slackCallbackContextSchema = z.looseObject({
  source: z.literal("slack"),
  channel: z.string(),
  threadTs: z.string(),
  repoFullName: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  reactionMessageTs: z.string().optional(),
});

const completionCallbackSchema = z.looseObject({
  sessionId: z.string(),
  messageId: z.string(),
  success: z.boolean(),
  error: z.string().optional(),
  timestamp: z.number(),
  signature: z.string(),
  context: slackCallbackContextSchema,
});

const toolCallCallbackSchema = z.looseObject({
  sessionId: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  callId: z.string(),
  timestamp: z.number(),
  signature: z.string(),
  context: slackCallbackContextSchema,
});

type ToolCallCallbackPayload = z.infer<typeof toolCallCallbackSchema>;

function isSignedCallbackPayload(
  payload: unknown
): payload is Record<string, unknown> & { signature: string; sessionId?: string } {
  return (
    isPlainRecord(payload) &&
    typeof payload.signature === "string" &&
    (payload.sessionId === undefined || typeof payload.sessionId === "string")
  );
}

const automationCompleteSchema = z.looseObject({
  channel: z.string().min(1),
  reactionMessageTs: z.string().min(1),
  sessionId: z.string().min(1),
  messageId: z.string().min(1),
  success: z.boolean(),
  error: z.string().optional(),
  repoFullName: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
  signature: z.string(),
});

/** Payload for a concurrency-skip ephemeral notice. */
interface AutomationSkipPayload {
  channel: string;
  user: string;
  threadTs: string;
  signature: string;
}

function isValidAutomationSkipPayload(payload: unknown): payload is AutomationSkipPayload {
  if (!isPlainRecord(payload)) return false;
  const p = payload;
  return (
    typeof p.channel === "string" &&
    typeof p.user === "string" &&
    typeof p.threadTs === "string" &&
    typeof p.signature === "string"
  );
}

/**
 * Shared rejection guard for signed callback routes: validate the payload shape,
 * require the signing secret, then verify the in-body HMAC signature. Returns a
 * Response to short-circuit on any failure, or null when the request is
 * authentic and the caller may proceed. Parsing stays in each route so the
 * caller controls how a malformed body is surfaced.
 */
async function rejectInvalidCallback(
  c: Context<{ Bindings: Env }>,
  payload: { signature: string; sessionId?: string },
  opts: { path: string; traceId: string; startTime: number }
): Promise<Response | null> {
  const { path, traceId, startTime } = opts;

  if (!c.env.SERVICE_AUTH_SECRET) {
    log.error("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: path,
      http_status: 500,
      outcome: "error",
      reject_reason: "secret_not_configured",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "not configured" }, 500);
  }

  const authentic = await verifyCallbackFromControlPlane(payload, c.env);
  if (!authentic) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: path,
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      session_id: payload.sessionId,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  return null;
}

function rejectInvalidPayload(
  c: Context<{ Bindings: Env }>,
  path: string,
  traceId: string,
  startTime: number
): Response {
  log.warn("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: path,
    http_status: 400,
    outcome: "rejected",
    reject_reason: "invalid_payload",
    duration_ms: Date.now() - startTime,
  });
  return c.json({ error: "invalid payload" }, 400);
}

async function enqueueCompletion(
  c: Context<{ Bindings: Env }>,
  job: SlackCompletionJob,
  path: string,
  startTime: number
): Promise<Response> {
  try {
    await c.env.SLACK_COMPLETION_QUEUE.send(job, { contentType: "json" });
  } catch (error) {
    log.error("slack.completion.enqueue", {
      trace_id: job.traceId,
      delivery_id: job.deliveryId,
      session_id: job.sessionId,
      message_id: job.messageId,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "completion enqueue failed" }, 503);
  }

  log.info("http.request", {
    trace_id: job.traceId,
    delivery_id: job.deliveryId,
    http_method: "POST",
    http_path: path,
    http_status: 200,
    session_id: job.sessionId,
    message_id: job.messageId,
    duration_ms: Date.now() - startTime,
  });
  return c.json({ ok: true, deliveryId: job.deliveryId });
}

export const callbacksRouter = new Hono<{ Bindings: Env }>();

/**
 * Callback endpoint for session completion notifications.
 */
callbacksRouter.post("/complete", async (c) => {
  const startTime = Date.now();
  // Use trace_id from control-plane if present, otherwise generate one
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json();
  const parsed = completionCallbackSchema.safeParse(payload);
  if (!parsed.success || !isSignedCallbackPayload(payload)) {
    return rejectInvalidPayload(c, "/callbacks/complete", traceId, startTime);
  }
  const valid = parsed.data;

  const rejection = await rejectInvalidCallback(c, payload, {
    path: "/callbacks/complete",
    traceId,
    startTime,
  });
  if (rejection) return rejection;

  return enqueueCompletion(
    c,
    createSlackCompletionJob({
      source: "session",
      sessionId: valid.sessionId,
      messageId: valid.messageId,
      success: valid.success,
      error: valid.error,
      channel: valid.context.channel,
      threadTs: valid.context.threadTs,
      reactionMessageTs: valid.context.reactionMessageTs,
      context: {
        repoFullName: valid.context.repoFullName,
        model: valid.context.model,
        reasoningEffort: valid.context.reasoningEffort,
      },
      traceId,
    }),
    "/callbacks/complete",
    startTime
  );
});

/**
 * Callback endpoint for in-flight tool-call notifications.
 */
callbacksRouter.post("/tool_call", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  let payload: unknown;

  try {
    payload = await c.req.json();
  } catch {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/tool_call",
      http_status: 400,
      outcome: "rejected",
      reject_reason: "invalid_json",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "invalid payload" }, 400);
  }

  const parsed = toolCallCallbackSchema.safeParse(payload);
  if (!parsed.success || !isSignedCallbackPayload(payload)) {
    return rejectInvalidPayload(c, "/callbacks/tool_call", traceId, startTime);
  }
  const valid = parsed.data;

  const rejection = await rejectInvalidCallback(c, payload, {
    path: "/callbacks/tool_call",
    traceId,
    startTime,
  });
  if (rejection) return rejection;

  c.executionCtx.waitUntil(handleToolCallCallback(valid, c.env, traceId));

  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/callbacks/tool_call",
    http_status: 200,
    session_id: valid.sessionId,
    tool: valid.tool,
    call_id: valid.callId,
    duration_ms: Date.now() - startTime,
  });

  return c.json({ ok: true });
});

/**
 * Callback endpoint for Slack-triggered automation completion. Posts the agent's
 * final response into the triggering message's thread and clears the `eyes`
 * reaction. The SchedulerDO owns this fan-out (it holds the message coordinates).
 */
callbacksRouter.post("/automation-complete", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }

  const parsed = automationCompleteSchema.safeParse(payload);
  if (!parsed.success || !isSignedCallbackPayload(payload)) {
    return rejectInvalidPayload(c, "/callbacks/automation-complete", traceId, startTime);
  }
  const valid = parsed.data;

  const rejection = await rejectInvalidCallback(c, payload, {
    path: "/callbacks/automation-complete",
    traceId,
    startTime,
  });
  if (rejection) return rejection;

  return enqueueCompletion(
    c,
    createSlackCompletionJob({
      source: "automation",
      sessionId: valid.sessionId,
      messageId: valid.messageId,
      success: valid.success,
      error: valid.error,
      channel: valid.channel,
      threadTs: valid.reactionMessageTs,
      reactionMessageTs: valid.reactionMessageTs,
      context: {
        repoFullName: valid.repoFullName,
        model: valid.model,
        reasoningEffort: valid.reasoningEffort,
      },
      traceId,
    }),
    "/callbacks/automation-complete",
    startTime
  );
});

/**
 * Callback endpoint for a concurrency-skip notice. Posts a best-effort
 * ephemeral reply to the message author when their message was dropped because
 * a run is already active for the thread.
 */
callbacksRouter.post("/automation-skip", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();

  let payload: unknown;
  try {
    payload = await c.req.json();
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!isValidAutomationSkipPayload(payload)) {
    return rejectInvalidPayload(c, "/callbacks/automation-skip", traceId, startTime);
  }

  const rejection = await rejectInvalidCallback(c, payload, {
    path: "/callbacks/automation-skip",
    traceId,
    startTime,
  });
  if (rejection) return rejection;

  c.executionCtx.waitUntil(handleAutomationSkip(payload as AutomationSkipPayload, c.env, traceId));

  return c.json({ ok: true });
});

async function handleToolCallCallback(
  payload: ToolCallCallbackPayload,
  env: Env,
  traceId?: string
): Promise<void> {
  const startTime = Date.now();
  const { context } = payload;
  const base = {
    trace_id: traceId,
    session_id: payload.sessionId,
    tool: payload.tool,
    call_id: payload.callId,
    channel: context.channel,
    thread_ts: context.threadTs,
  };

  const status = formatToolStatus(payload.tool, payload.args);
  await setAssistantThreadStatusBestEffort(env, context.channel, context.threadTs, status, {
    event: "tool_call",
    traceId,
    sessionId: payload.sessionId,
    tool: payload.tool,
    callId: payload.callId,
  });

  log.info("callback.tool_call", {
    ...base,
    outcome: "success",
    duration_ms: Date.now() - startTime,
  });
}

/**
 * Post a best-effort ephemeral "a run is already active" notice to the author
 * whose message was dropped by the per-thread concurrency guard.
 */
async function handleAutomationSkip(
  payload: AutomationSkipPayload,
  env: Env,
  traceId?: string
): Promise<void> {
  // Runs in waitUntil — postEphemeral can throw (network/runtime), so catch here
  // or the background task rejects without route-level logging.
  try {
    const result = await postEphemeral(
      env.SLACK_BOT_TOKEN,
      payload.channel,
      payload.user,
      ":hourglass_flowing_sand: A run is already active for this thread — skipping the new trigger.",
      { thread_ts: payload.threadTs }
    );

    if (!result.ok) {
      log.warn("callback.automation_skip", {
        trace_id: traceId,
        channel: payload.channel,
        user: payload.user,
        outcome: "error",
        slack_error: result.error,
      });
    }
  } catch (error) {
    log.warn("callback.automation_skip", {
      trace_id: traceId,
      channel: payload.channel,
      user: payload.user,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    });
  }
}
