/**
 * Callback handlers for control-plane notifications.
 */

import {
  computeHmacHex,
  postEphemeral,
  postMessage,
  removeReaction,
  timingSafeEqual,
} from "@open-inspect/shared";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { Env } from "./types";
import { extractAgentResponse } from "./completion/extractor";
import { buildCompletionBlocks, getFallbackText, truncateError } from "./completion/blocks";
import { createLogger } from "./logger";
import { formatToolStatus, setAssistantThreadStatusBestEffort } from "./activity-status";

const log = createLogger("callback");

async function clearThinkingReaction(
  env: Env,
  channel: string,
  reactionMessageTs: string,
  traceId?: string
): Promise<void> {
  const reactionResult = await removeReaction(
    env.SLACK_BOT_TOKEN,
    channel,
    reactionMessageTs,
    "eyes"
  );

  if (!reactionResult.ok && reactionResult.error !== "no_reaction") {
    log.warn("slack.reaction.remove", {
      trace_id: traceId,
      channel,
      message_ts: reactionMessageTs,
      reaction: "eyes",
      slack_error: reactionResult.error,
    });
  }
}

/**
 * Verify internal callback signature using shared secret.
 * Prevents external callers from forging completion callbacks.
 */
async function verifyCallbackSignature<T extends { signature: string }>(
  payload: T,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const expectedHex = await computeHmacHex(JSON.stringify(data), secret);
  return timingSafeEqual(signature, expectedHex);
}

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

type CompletionCallbackPayload = z.infer<typeof completionCallbackSchema>;

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

/**
 * Payload for a scheduler-owned automation completion (Slack-triggered run). The
 * SchedulerDO posts this when the run finishes. The bot posts the agent's final
 * response into the triggering message's thread and clears the `eyes` reaction.
 *
 * The run-result fields (`sessionId`/`messageId` and the presentation fields) are
 * optional so a control-plane/bot version skew degrades to a reaction clear only.
 */
interface AutomationCompletePayload {
  channel: string;
  /** The triggering message: thread anchor for the result and the `eyes` reaction target. */
  reactionMessageTs: string;
  sessionId?: string;
  messageId?: string;
  success?: boolean;
  error?: string;
  repoFullName?: string;
  model?: string;
  reasoningEffort?: string;
  signature: string;
}

function isValidAutomationCompletePayload(payload: unknown): payload is AutomationCompletePayload {
  if (!isPlainRecord(payload)) return false;
  const p = payload;
  return (
    typeof p.channel === "string" &&
    typeof p.reactionMessageTs === "string" &&
    typeof p.signature === "string" &&
    (p.sessionId === undefined || typeof p.sessionId === "string") &&
    (p.messageId === undefined || typeof p.messageId === "string")
  );
}

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

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
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

  const authentic = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
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

  // Process in background
  c.executionCtx.waitUntil(handleCompletionCallback(valid, c.env, traceId));

  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/callbacks/complete",
    http_status: 200,
    session_id: valid.sessionId,
    message_id: valid.messageId,
    duration_ms: Date.now() - startTime,
  });

  return c.json({ ok: true });
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

  if (!isValidAutomationCompletePayload(payload)) {
    return rejectInvalidPayload(c, "/callbacks/automation-complete", traceId, startTime);
  }

  const rejection = await rejectInvalidCallback(c, payload, {
    path: "/callbacks/automation-complete",
    traceId,
    startTime,
  });
  if (rejection) return rejection;

  c.executionCtx.waitUntil(
    handleAutomationComplete(payload as AutomationCompletePayload, c.env, traceId)
  );

  return c.json({ ok: true });
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
 * Handle completion callback - fetch events and post to Slack.
 */
async function handleCompletionCallback(
  payload: CompletionCallbackPayload,
  env: Env,
  traceId?: string
): Promise<void> {
  const startTime = Date.now();
  const { sessionId, context } = payload;
  const base = {
    trace_id: traceId,
    session_id: sessionId,
    message_id: payload.messageId,
    channel: context.channel,
  };

  try {
    // Fetch events to build response (filtered by messageId directly)
    const agentResponse = await extractAgentResponse(env, sessionId, payload.messageId, traceId);

    // Fall back to the callback payload's error if the extractor didn't find one.
    agentResponse.error = agentResponse.error || payload.error;
    const errorMessage = agentResponse.error;

    // Check if extraction succeeded (has content or was explicitly successful)
    if (!agentResponse.textContent && agentResponse.toolCalls.length === 0 && !payload.success) {
      const displayError = truncateError(errorMessage || "Unknown error", 2000);
      log.error("callback.complete", {
        ...base,
        outcome: "error",
        error_message: "empty_agent_response",
        agent_error: errorMessage || "Unknown error",
        duration_ms: Date.now() - startTime,
      });
      await postMessage(env.SLACK_BOT_TOKEN, context.channel, `The agent failed: ${displayError}`, {
        thread_ts: context.threadTs,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: `:x: *Agent failed:* ${displayError}`,
            },
          },
          {
            type: "actions",
            elements: [
              {
                type: "button",
                text: { type: "plain_text", text: "View Session" },
                url: `${env.WEB_APP_URL}/session/${sessionId}`,
                action_id: "view_session",
              },
            ],
          },
        ],
      });

      if (context.reactionMessageTs) {
        await clearThinkingReaction(env, context.channel, context.reactionMessageTs, traceId);
      }
      return;
    }

    // Build and post completion message
    const blocks = buildCompletionBlocks(sessionId, agentResponse, context, env.WEB_APP_URL);

    await postMessage(env.SLACK_BOT_TOKEN, context.channel, getFallbackText(agentResponse), {
      thread_ts: context.threadTs,
      blocks,
    });

    if (context.reactionMessageTs) {
      await clearThinkingReaction(env, context.channel, context.reactionMessageTs, traceId);
    }

    log.info("callback.complete", {
      ...base,
      outcome: "success",
      agent_success: payload.success,
      tool_call_count: agentResponse.toolCalls.length,
      artifact_count: agentResponse.artifacts.length,
      has_text: Boolean(agentResponse.textContent),
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    log.error("callback.complete", {
      ...base,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
    // Don't throw - this is fire-and-forget
  }
}

/**
 * Post a Slack-triggered run's result into the triggering message's thread and
 * clear the `eyes` reaction. Reuses the interactive completion path
 * (`handleCompletionCallback`) — which fetches the agent's response, posts it
 * in-thread, and clears the reaction. Falls back to a reaction clear only when
 * the run carries no session coordinates (control-plane/bot version skew).
 * Fire-and-forget.
 */
async function handleAutomationComplete(
  payload: AutomationCompletePayload,
  env: Env,
  traceId?: string
): Promise<void> {
  if (payload.sessionId && payload.messageId) {
    await handleCompletionCallback(
      {
        sessionId: payload.sessionId,
        messageId: payload.messageId,
        success: payload.success ?? true,
        error: payload.error,
        timestamp: Date.now(),
        signature: payload.signature,
        context: {
          source: "slack",
          channel: payload.channel,
          threadTs: payload.reactionMessageTs,
          reactionMessageTs: payload.reactionMessageTs,
          repoFullName: payload.repoFullName ?? "",
          model: payload.model ?? "",
          reasoningEffort: payload.reasoningEffort,
        },
      },
      env,
      traceId
    );
    return;
  }

  // No session coordinates — clear the reaction only.
  const startTime = Date.now();
  const base = {
    trace_id: traceId,
    channel: payload.channel,
    message_ts: payload.reactionMessageTs,
  };
  try {
    await clearThinkingReaction(env, payload.channel, payload.reactionMessageTs, traceId);

    log.info("callback.automation_complete", {
      ...base,
      outcome: "success",
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    log.error("callback.automation_complete", {
      ...base,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
  }
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
