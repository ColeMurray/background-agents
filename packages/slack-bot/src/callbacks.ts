/**
 * Callback handlers for control-plane notifications.
 */

import {
  buildInternalAuthHeaders,
  computeHmacHex,
  postMessage,
  removeReaction,
  timingSafeEqual,
  updateMessage,
} from "@open-inspect/shared";
import type { PlanApprovalStatus, PlanArtifact } from "@open-inspect/shared";
import { Hono } from "hono";
import type { Env, CompletionCallback, PlanStatusCallback, ToolCallCallback } from "./types";
import { extractAgentResponse } from "./completion/extractor";
import {
  buildCompletionBlocks,
  buildPlanAwaitingApprovalBlocks,
  buildPlanDecidedBlocks,
  getFallbackText,
  truncateError,
} from "./completion/blocks";
import { createLogger } from "./logger";
import { formatToolStatus, setAssistantThreadStatusBestEffort } from "./activity-status";

/**
 * KV key for the message-ts of the "Plan vN awaiting approval" message
 * the slack-bot posted for a given session. Lets us `chat.update` it
 * when a cross-channel verdict (e.g. web approval) lands. TTL is short
 * by design — plans are decided in minutes, not hours.
 */
function planAwaitingMessageKvKey(sessionId: string): string {
  return `plan-awaiting-msg:${sessionId}`;
}

const PLAN_AWAITING_MSG_TTL_SECONDS = 60 * 60 * 24 * 7; // 7 days

interface PlanAwaitingMessageRef {
  channel: string;
  messageTs: string;
  planVersion: number;
}

const log = createLogger("callback");

async function fetchPlanSnapshot(
  env: Env,
  sessionId: string,
  traceId?: string
): Promise<{ status: PlanApprovalStatus | null; plan: PlanArtifact | null } | null> {
  try {
    if (!env.INTERNAL_CALLBACK_SECRET) return null;
    const headers = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId);
    const res = await env.CONTROL_PLANE.fetch(`https://internal/sessions/${sessionId}/plan`, {
      method: "GET",
      headers,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      plan: PlanArtifact | null;
      status: PlanApprovalStatus | null;
    };
    return { status: body.status ?? null, plan: body.plan ?? null };
  } catch (e) {
    log.warn("callback.plan_snapshot_failed", {
      trace_id: traceId,
      session_id: sessionId,
      error: e instanceof Error ? e : new Error(String(e)),
    });
    return null;
  }
}

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
 * Prevents external callers from forging callbacks. Generic over any
 * payload shape carrying a `signature` field — works for both the
 * completion callback and the plan-status callback.
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

/**
 * Validate callback payload shape.
 */
function isValidPayload(payload: unknown): payload is CompletionCallback {
  if (!isPlainRecord(payload)) return false;
  const p = payload;
  return (
    typeof p.sessionId === "string" &&
    typeof p.messageId === "string" &&
    typeof p.success === "boolean" &&
    typeof p.timestamp === "number" &&
    typeof p.signature === "string" &&
    isPlainRecord(p.context) &&
    typeof p.context.channel === "string" &&
    typeof p.context.threadTs === "string"
  );
}

function isValidSlackCallbackContext(context: unknown): boolean {
  return (
    isPlainRecord(context) &&
    context.source === "slack" &&
    typeof context.channel === "string" &&
    typeof context.threadTs === "string"
  );
}

/**
 * Validate tool-call callback payload shape.
 */
function isValidToolCallPayload(payload: unknown): payload is ToolCallCallback {
  if (!isPlainRecord(payload)) return false;
  const p = payload;
  return (
    typeof p.sessionId === "string" &&
    typeof p.tool === "string" &&
    isPlainRecord(p.args) &&
    typeof p.callId === "string" &&
    typeof p.timestamp === "number" &&
    typeof p.signature === "string" &&
    isValidSlackCallbackContext(p.context)
  );
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

  // Validate payload shape
  if (!isValidPayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/complete",
      http_status: 400,
      outcome: "rejected",
      reject_reason: "invalid_payload",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "invalid payload" }, 400);
  }

  // Verify signature (prevents external forgery)
  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    log.error("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/complete",
      http_status: 500,
      outcome: "error",
      reject_reason: "secret_not_configured",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "not configured" }, 500);
  }

  const isValid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/complete",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      session_id: payload.sessionId,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  // Process in background
  c.executionCtx.waitUntil(handleCompletionCallback(payload, c.env, traceId));

  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/callbacks/complete",
    http_status: 200,
    session_id: payload.sessionId,
    message_id: payload.messageId,
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

  if (!isValidToolCallPayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/tool_call",
      http_status: 400,
      outcome: "rejected",
      reject_reason: "invalid_payload",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    log.error("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/tool_call",
      http_status: 500,
      outcome: "error",
      reject_reason: "secret_not_configured",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "not configured" }, 500);
  }

  const isValid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/tool_call",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      session_id: payload.sessionId,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(handleToolCallCallback(payload, c.env, traceId));

  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/callbacks/tool_call",
    http_status: 200,
    session_id: payload.sessionId,
    tool: payload.tool,
    call_id: payload.callId,
    duration_ms: Date.now() - startTime,
  });

  return c.json({ ok: true });
});

async function handleToolCallCallback(
  payload: ToolCallCallback,
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
  payload: CompletionCallback,
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

    // Plan-mode short-circuit: if the agent's turn produced a plan that's now
    // awaiting approval, post an in-thread Block Kit message with Approve /
    // Reject buttons instead of the regular completion. The buttons trigger
    // modals that call the control-plane plan endpoint directly.
    const planSnapshot = payload.success ? await fetchPlanSnapshot(env, sessionId, traceId) : null;
    if (payload.success && planSnapshot?.status === "awaiting_approval" && planSnapshot.plan) {
      const planBlocks = buildPlanAwaitingApprovalBlocks(
        sessionId,
        planSnapshot.plan,
        env.WEB_APP_URL
      );
      const postResult = await postMessage(
        env.SLACK_BOT_TOKEN,
        context.channel,
        `Plan ready (v${planSnapshot.plan.version}) — awaiting your approval`,
        { thread_ts: context.threadTs, blocks: planBlocks }
      );

      // Persist the awaiting-message ref so a cross-channel verdict
      // (web approval, etc.) can `chat.update` THIS exact message via
      // the /callbacks/plan-status path. Same-channel verdicts continue
      // to update via the modal handler's `private_metadata` path.
      if (postResult.ok && postResult.ts) {
        const ref: PlanAwaitingMessageRef = {
          channel: context.channel,
          messageTs: postResult.ts,
          planVersion: planSnapshot.plan.version,
        };
        try {
          await env.SLACK_KV.put(planAwaitingMessageKvKey(sessionId), JSON.stringify(ref), {
            expirationTtl: PLAN_AWAITING_MSG_TTL_SECONDS,
          });
        } catch (e) {
          log.warn("slack.plan_awaiting_msg.kv_put_failed", {
            ...base,
            error: e instanceof Error ? e : new Error(String(e)),
          });
        }
      }

      if (context.reactionMessageTs) {
        await clearThinkingReaction(env, context.channel, context.reactionMessageTs, traceId);
      }

      log.info("callback.complete", {
        ...base,
        outcome: "success",
        agent_success: payload.success,
        flow: "plan_awaiting_approval",
        plan_version: planSnapshot.plan.version,
        duration_ms: Date.now() - startTime,
      });
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

// ─── Plan Status Callback ────────────────────────────────────────────────────

/**
 * Validate plan-status callback payload shape.
 */
export function isValidPlanStatusPayload(payload: unknown): payload is PlanStatusCallback {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.sessionId === "string" &&
    typeof p.planVersion === "number" &&
    typeof p.signature === "string" &&
    typeof p.timestamp === "number" &&
    (p.verdict === "approved" || p.verdict === "rejected") &&
    p.plan !== null &&
    typeof p.plan === "object" &&
    p.context !== null &&
    typeof p.context === "object"
  );
}

/**
 * Callback endpoint for cross-channel plan-verdict notifications. Fires
 * when the user approved/rejected the plan from a surface other than
 * the Slack modal (e.g. the web UI). We chat.update the original
 * "Plan awaiting approval" message into the terminal-verdict form,
 * reusing the same blocks as the modal-driven path so the result is
 * indistinguishable to the user.
 *
 * No-ops when the awaiting-message ref is missing from KV (the
 * same-channel modal handler already updated it, or the ref expired —
 * either way the user has already seen a verdict somewhere else).
 */
callbacksRouter.post("/plan-status", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json().catch(() => null);

  if (!isValidPlanStatusPayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/plan-status",
      http_status: 400,
      outcome: "rejected",
      reject_reason: "invalid_payload",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "invalid payload" }, 400);
  }

  if (!c.env.INTERNAL_CALLBACK_SECRET) {
    log.error("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/plan-status",
      http_status: 500,
      outcome: "error",
      reject_reason: "secret_not_configured",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "not configured" }, 500);
  }

  const isValid = await verifyCallbackSignature(payload, c.env.INTERNAL_CALLBACK_SECRET);
  if (!isValid) {
    log.warn("http.request", {
      trace_id: traceId,
      http_method: "POST",
      http_path: "/callbacks/plan-status",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      session_id: payload.sessionId,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(handlePlanStatusCallback(payload, c.env, traceId));

  log.info("http.request", {
    trace_id: traceId,
    http_method: "POST",
    http_path: "/callbacks/plan-status",
    http_status: 200,
    session_id: payload.sessionId,
    plan_version: payload.planVersion,
    verdict: payload.verdict,
    duration_ms: Date.now() - startTime,
  });

  return c.json({ ok: true });
});

async function handlePlanStatusCallback(
  payload: PlanStatusCallback,
  env: Env,
  traceId: string
): Promise<void> {
  const { sessionId, planVersion, verdict, plan, approverAuthorId } = payload;
  const base = {
    trace_id: traceId,
    session_id: sessionId,
    plan_version: planVersion,
    verdict,
  };

  let ref: PlanAwaitingMessageRef | null = null;
  try {
    const raw = await env.SLACK_KV.get(planAwaitingMessageKvKey(sessionId));
    if (raw) ref = JSON.parse(raw) as PlanAwaitingMessageRef;
  } catch (e) {
    log.warn("callback.plan_status.kv_get_failed", {
      ...base,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }

  if (!ref) {
    // Either the same-channel modal handler already updated the message
    // (and cleared the ref), or we never posted an awaiting message for
    // this session, or the ref expired. Nothing to update — return.
    log.info("callback.plan_status", {
      ...base,
      outcome: "noop",
      reason: "no_awaiting_message_ref",
    });
    return;
  }

  // Best-effort actor mention. Cross-channel verdicts are typically
  // "web:<userId>" — we don't have a Slack handle for the actor, so fall
  // back to a generic label that still tells the user where the verdict
  // came from.
  const actorMention = formatCrossChannelActor(approverAuthorId);

  const blocks = buildPlanDecidedBlocks({
    sessionId,
    plan: plan as PlanArtifact,
    webAppUrl: env.WEB_APP_URL,
    verdict,
    actorMention,
    implementationModelLabel: payload.implementationModel,
    reason: payload.reason ?? null,
  });

  const fallback =
    verdict === "approved" ? `Plan v${planVersion} approved` : `Plan v${planVersion} rejected`;
  try {
    const result = await updateMessage(env.SLACK_BOT_TOKEN, ref.channel, ref.messageTs, fallback, {
      blocks,
    });
    if (!result.ok) {
      log.warn("callback.plan_status.update_failed", {
        ...base,
        channel: ref.channel,
        message_ts: ref.messageTs,
        slack_error: result.error,
      });
      return;
    }

    // Clear the ref so subsequent late-arriving callbacks (e.g. a Slack
    // modal submission concurrent with web approval) don't re-update.
    try {
      await env.SLACK_KV.delete(planAwaitingMessageKvKey(sessionId));
    } catch {
      /* best-effort */
    }

    log.info("callback.plan_status", {
      ...base,
      outcome: "updated",
      channel: ref.channel,
    });
  } catch (e) {
    log.error("callback.plan_status.update_error", {
      ...base,
      channel: ref.channel,
      message_ts: ref.messageTs,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

/**
 * Render a human-readable actor label for a cross-channel verdict.
 * Cross-channel approvers come in as `"web:<userId>"`, `"linear:<id>"`,
 * etc. — there's no canonical Slack handle to mention, so we collapse
 * the source prefix into a "(in <source>)" suffix.
 */
export function formatCrossChannelActor(approverAuthorId: string | null): string {
  if (!approverAuthorId) return "someone";
  const idx = approverAuthorId.indexOf(":");
  if (idx <= 0) return "someone";
  const source = approverAuthorId.slice(0, idx);
  return `someone in ${source}`;
}
