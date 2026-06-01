/**
 * Callback handlers for control-plane completion notifications.
 * Uses richer response extraction and formats as Linear AgentActivities.
 */

import { Hono } from "hono";
import type {
  Env,
  CompletionCallback,
  PlanStatusCallback,
  SessionLifecycleCallback,
  ToolCallCallback,
} from "./types";
import {
  getLinearClient,
  emitAgentActivity,
  postIssueComment,
  updateAgentSession,
} from "./utils/linear-client";
import { extractAgentResponse, formatAgentResponse } from "./completion/extractor";
import { resolveAppName, timingSafeEqual } from "@open-inspect/shared";
import type { PlanApprovalStatus, PlanArtifact } from "@open-inspect/shared";
import { computeHmacHex } from "./utils/crypto";
import { makePlan } from "./plan";
import { buildInternalAuthHeaders } from "./utils/internal";
import { createLogger } from "./logger";

const log = createLogger("callback");

export async function verifyCallbackSignature<T extends { signature: string }>(
  payload: T,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const expectedHex = await computeHmacHex(JSON.stringify(data), secret);
  return timingSafeEqual(signature, expectedHex);
}

export function formatCompletionComment(
  appName: string,
  success: boolean,
  message: string
): string {
  return success
    ? `## 🤖 ${appName} completed\n\n${message}`
    : `## ⚠️ ${appName} encountered an issue\n\n${message}`;
}

function formatPlanAwaitingApproval(
  plan: PlanArtifact,
  webSessionUrl: string,
  appName: string
): string {
  const planBody =
    plan.content.length > 4000 ? `${plan.content.slice(0, 4000)}\n\n…` : plan.content;
  return (
    `### Plan ready — awaiting your approval\n\n` +
    `${appName} proposed the plan below for this issue (version ${plan.version}).\n\n` +
    `**To proceed, reply in this thread:**\n` +
    `- \`approve\` — start the build (uses the model from a \`model-<alias>\` ` +
    `or \`build-<alias>\` label on this issue, else the default)\n` +
    `- \`reject\` — discard this plan; optionally add a reason on the same line\n\n` +
    `To switch the build model, add a label like \`build-sonnet\` or ` +
    `\`model-opus\` to this issue before approving. Or ` +
    `[open the session in the web app](${webSessionUrl}#plan) to approve from the web. ` +
    `Any other reply will ask the agent to amend the plan.\n\n` +
    `---\n\n` +
    planBody
  );
}

async function fetchPlanSnapshot(
  env: Env,
  sessionId: string,
  traceId?: string
): Promise<{ status: PlanApprovalStatus | null; plan: PlanArtifact | null } | null> {
  try {
    const headers = await buildInternalAuthHeaders(env.INTERNAL_CALLBACK_SECRET, traceId);
    const stateRes = await env.CONTROL_PLANE.fetch(`https://internal/sessions/${sessionId}/plan`, {
      method: "GET",
      headers,
    });
    if (!stateRes.ok) return null;
    const stateBody = (await stateRes.json()) as {
      plan: PlanArtifact | null;
      status: PlanApprovalStatus | null;
    };
    return {
      status: stateBody.status ?? null,
      plan: stateBody.plan ?? null,
    };
  } catch (e) {
    log.warn("callback.plan_snapshot_failed", {
      trace_id: traceId,
      session_id: sessionId,
      error: e instanceof Error ? e : String(e),
    });
    return null;
  }
}

export function isValidPayload(payload: unknown): payload is CompletionCallback {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.sessionId === "string" &&
    typeof p.messageId === "string" &&
    typeof p.success === "boolean" &&
    typeof p.timestamp === "number" &&
    typeof p.signature === "string" &&
    p.context !== null &&
    typeof p.context === "object" &&
    typeof (p.context as Record<string, unknown>).issueId === "string"
  );
}

export const callbacksRouter = new Hono<{ Bindings: Env }>();

callbacksRouter.post("/complete", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json();

  if (!isValidPayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/callbacks/complete",
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
      http_path: "/callbacks/complete",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(handleCompletionCallback(payload, c.env, traceId));

  return c.json({ ok: true });
});

// ─── Tool Call Callback ──────────────────────────────────────────────────────

/**
 * Linear's Agent API requires `action`-typed activities to carry `action` and
 * `parameter` fields (not `body`). The `action` is the verb shown in the UI,
 * the `parameter` is the operand. Both fields must be present and non-empty.
 */
export function formatToolAction(
  tool: string,
  args: Record<string, unknown>
): { action: string; parameter: string } {
  switch (tool) {
    case "edit_file":
    case "write_file":
      return { action: "Edit", parameter: String(args.filepath || args.path || "file") };
    case "read_file":
      return { action: "Read", parameter: String(args.filepath || args.path || "file") };
    case "bash":
    case "execute_command": {
      const cmd = String(args.command || args.cmd || "");
      return {
        action: "Run",
        parameter: cmd.length > 80 ? cmd.slice(0, 77) + "..." : cmd || "(no command)",
      };
    }
    default: {
      const firstStringArg = Object.values(args).find((v) => typeof v === "string");
      return {
        // Linear rejects activities with an empty `action`; the upstream
        // validator allows tool === "" so guard here.
        action: tool || "Tool",
        parameter: firstStringArg ? String(firstStringArg).slice(0, 200) : "(no args)",
      };
    }
  }
}

export function isValidToolCallPayload(payload: unknown): payload is ToolCallCallback {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.sessionId === "string" &&
    typeof p.tool === "string" &&
    typeof p.timestamp === "number" &&
    typeof p.signature === "string" &&
    p.context !== null &&
    typeof p.context === "object"
  );
}

callbacksRouter.post("/tool_call", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json();

  if (!isValidToolCallPayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
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
      http_path: "/callbacks/tool_call",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      session_id: payload.sessionId,
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(
    (async () => {
      const processStart = Date.now();
      const { context } = payload;

      if (!context.agentSessionId || !context.organizationId) {
        log.debug("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          tool: payload.tool,
          outcome: "skipped",
          skip_reason: "missing_agent_context",
          duration_ms: Date.now() - processStart,
        });
        return;
      }

      // Default to true for backward compat with sessions created before this field existed
      if (context.emitToolProgressActivities === false) {
        log.debug("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          agent_session_id: context.agentSessionId,
          tool: payload.tool,
          outcome: "skipped",
          skip_reason: "activities_disabled",
          duration_ms: Date.now() - processStart,
        });
        return;
      }

      const client = await getLinearClient(c.env, context.organizationId);
      if (!client) {
        log.warn("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          agent_session_id: context.agentSessionId,
          org_id: context.organizationId,
          tool: payload.tool,
          outcome: "skipped",
          skip_reason: "no_oauth_token",
          duration_ms: Date.now() - processStart,
        });
        return;
      }

      try {
        const { action, parameter } = formatToolAction(payload.tool, payload.args);
        await emitAgentActivity(
          client,
          context.agentSessionId,
          { type: "action", action, parameter },
          true
        );
        log.info("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          agent_session_id: context.agentSessionId,
          tool: payload.tool,
          outcome: "success",
          duration_ms: Date.now() - processStart,
        });
      } catch (e) {
        log.warn("callback.tool_call", {
          trace_id: traceId,
          session_id: payload.sessionId,
          agent_session_id: context.agentSessionId,
          tool: payload.tool,
          outcome: "error",
          error: e instanceof Error ? e : new Error(String(e)),
          duration_ms: Date.now() - processStart,
        });
      }
    })()
  );

  return c.json({ ok: true });
});

// ─── Completion Callback ─────────────────────────────────────────────────────

async function handleCompletionCallback(
  payload: CompletionCallback,
  env: Env,
  traceId?: string
): Promise<void> {
  const startTime = Date.now();
  const { sessionId, context } = payload;

  try {
    // Extract rich agent response from events
    const agentResponse = await extractAgentResponse(env, sessionId, payload.messageId, traceId);

    // If this was a planning turn for a plan-mode session, the agent's response
    // has already been persisted as the current plan version by the bridge
    // (POST /sessions/:id/plan with source=agent). The control-plane has
    // flipped plan_approval_status to "awaiting_approval". Surface that to
    // Linear as a distinct "plan ready, please approve" activity instead of
    // the regular completion message.
    const planSnapshot = payload.success ? await fetchPlanSnapshot(env, sessionId, traceId) : null;
    const awaitingApproval =
      payload.success && planSnapshot?.status === "awaiting_approval" && planSnapshot.plan;

    let message: string;
    let activityType: "response" | "error" | "elicitation";

    if (awaitingApproval) {
      // Use elicitation so Linear surfaces this as an explicit "agent waiting
      // on you" state and prompts a follow-up reply (which the bot then
      // parses for approve/reject — see parsePlanCommand in webhook-handler).
      activityType = "elicitation";
      message = formatPlanAwaitingApproval(
        planSnapshot!.plan!,
        `${env.WEB_APP_URL}/session/${sessionId}`,
        resolveAppName(env)
      );
    } else if (payload.success) {
      activityType = "response";
      message = formatAgentResponse(agentResponse);
    } else {
      activityType = "error";
      if (agentResponse.textContent) {
        message = `The agent encountered an error.\n\n${agentResponse.textContent.slice(0, 500)}`;
      } else {
        message = `The agent was unable to complete this task.`;
      }
    }

    // Emit via Agent API if we have session context
    if (context.agentSessionId && context.organizationId) {
      const client = await getLinearClient(env, context.organizationId);
      if (client) {
        await emitAgentActivity(client, context.agentSessionId, {
          type: activityType,
          body: message,
        });

        // Update Linear's plan widget: don't mark complete while a plan is
        // awaiting approval — the impl steps haven't run yet.
        const stage = awaitingApproval
          ? "plan_awaiting_approval"
          : payload.success
            ? "completed"
            : "failed";
        await updateAgentSession(client, context.agentSessionId, {
          plan: makePlan(stage),
        });

        // Update externalUrls with PR link if available
        const prArtifact = agentResponse.artifacts.find((a) => a.type === "pr" && a.url);
        if (prArtifact) {
          const urls = [
            { label: "View Session", url: `${env.WEB_APP_URL}/session/${sessionId}` },
            { label: "Pull Request", url: prArtifact.url },
          ];
          await updateAgentSession(client, context.agentSessionId, { externalUrls: urls });
        }

        log.info("callback.complete", {
          trace_id: traceId,
          session_id: sessionId,
          issue_id: context.issueId,
          issue_identifier: context.issueIdentifier,
          agent_session_id: context.agentSessionId,
          outcome: payload.success ? "success" : "failed",
          has_pr: agentResponse.artifacts.some((a) => a.type === "pr" && a.url),
          agent_success: payload.success,
          tool_call_count: agentResponse.toolCalls.length,
          artifact_count: agentResponse.artifacts.length,
          delivery: "agent_activity",
          delivery_outcome: "success",
          duration_ms: Date.now() - startTime,
        });
        return;
      }
      log.warn("callback.no_oauth_token", {
        trace_id: traceId,
        org_id: context.organizationId,
      });
    }

    // Fallback: post a comment (requires LINEAR_API_KEY)
    if (!env.LINEAR_API_KEY) {
      log.warn("callback.no_linear_api_key", {
        trace_id: traceId,
        session_id: sessionId,
        issue_id: context.issueId,
        message: "LINEAR_API_KEY not configured, cannot post fallback comment",
      });
      return;
    }

    const commentBody = formatCompletionComment(resolveAppName(env), payload.success, message);

    const result = await postIssueComment(env.LINEAR_API_KEY, context.issueId, commentBody);

    log.info("callback.complete", {
      trace_id: traceId,
      session_id: sessionId,
      issue_id: context.issueId,
      outcome: payload.success ? "success" : "failed",
      agent_success: payload.success,
      delivery: "comment_fallback",
      delivery_outcome: result.success ? "success" : "error",
      duration_ms: Date.now() - startTime,
    });
  } catch (error) {
    log.error("callback.complete", {
      trace_id: traceId,
      session_id: sessionId,
      issue_id: context.issueId,
      outcome: "error",
      error: error instanceof Error ? error : new Error(String(error)),
      duration_ms: Date.now() - startTime,
    });
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
    typeof p.context === "object" &&
    typeof (p.context as Record<string, unknown>).issueId === "string"
  );
}

/**
 * Cross-channel plan-verdict callback. Triggered when the user approved
 * or rejected the plan via a surface other than Linear (most commonly
 * the web UI). We emit a follow-up `response` activity in the Linear
 * agent session so the verdict is visible in the issue, and update the
 * Agent Session's plan widget to reflect the terminal state — the
 * elicitation activity above stays in place as a historical record.
 *
 * Same-channel (Linear-driven) verdicts continue to flow through
 * webhook-handler's existing `handlePlanCommand` path — the
 * control-plane's notifyPlanStatus skips firing in that case.
 */
callbacksRouter.post("/plan-status", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json().catch(() => null);

  if (!isValidPlanStatusPayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
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
      http_path: "/callbacks/plan-status",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(handlePlanStatusCallback(payload, c.env, traceId));
  return c.json({ ok: true });
});

async function handlePlanStatusCallback(
  payload: PlanStatusCallback,
  env: Env,
  traceId: string
): Promise<void> {
  const { sessionId, planVersion, verdict, context } = payload;
  const base = {
    trace_id: traceId,
    session_id: sessionId,
    plan_version: planVersion,
    verdict,
    issue_id: context.issueId,
  };

  // No agent session id = can't update Linear's activity stream. This is
  // the same precondition as the completion callback; the issue-comment
  // fallback path doesn't apply for plan-status updates (the elicitation
  // activity is the right surface).
  if (!context.agentSessionId || !context.organizationId) {
    log.info("callback.plan_status", {
      ...base,
      outcome: "noop",
      reason: "no_agent_session_context",
    });
    return;
  }

  const client = await getLinearClient(env, context.organizationId);
  if (!client) {
    log.warn("callback.plan_status.no_oauth_token", {
      ...base,
      org_id: context.organizationId,
    });
    return;
  }

  const actorMention = formatCrossChannelActor(
    payload.approverAuthorId,
    payload.approverDisplayName
  );
  const body =
    verdict === "approved"
      ? `Plan v${planVersion} approved by ${actorMention}. Implementation is starting.`
      : `Plan v${planVersion} rejected by ${actorMention}${
          payload.reason ? `: ${payload.reason}` : ""
        }.`;

  try {
    await emitAgentActivity(client, context.agentSessionId, {
      type: "response",
      body,
    });

    await updateAgentSession(client, context.agentSessionId, {
      plan: makePlan(verdict === "approved" ? "completed" : "failed"),
    });

    log.info("callback.plan_status", {
      ...base,
      outcome: "updated",
      delivery: "agent_activity",
    });
  } catch (e) {
    log.error("callback.plan_status.update_error", {
      ...base,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}

/**
 * Render a human-readable actor label for a cross-channel verdict.
 * Prefers `displayName` (web propagates it from `session.user.name`)
 * when available, falling back to `someone in <source>` for legacy
 * payloads. Linear's activity stream can't resolve cross-channel actors
 * to Linear handles, so the rendering is always plain text.
 */
export function formatCrossChannelActor(
  approverAuthorId: string | null,
  displayName?: string | null
): string {
  const source = extractActorSource(approverAuthorId);
  if (displayName && displayName.trim().length > 0) {
    return source ? `${displayName} (via ${source})` : displayName;
  }
  return source ? `someone in ${source}` : "someone";
}

function extractActorSource(approverAuthorId: string | null): string | null {
  if (!approverAuthorId) return null;
  const idx = approverAuthorId.indexOf(":");
  if (idx <= 0) return null;
  return approverAuthorId.slice(0, idx);
}

// ─── Session Lifecycle Callback ──────────────────────────────────────────────

/**
 * Validate session-lifecycle callback payload shape.
 */
export function isValidSessionLifecyclePayload(
  payload: unknown
): payload is SessionLifecycleCallback {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.sessionId === "string" &&
    (p.event === "archived" || p.event === "unarchived") &&
    typeof p.signature === "string" &&
    typeof p.timestamp === "number" &&
    p.context !== null &&
    typeof p.context === "object" &&
    typeof (p.context as Record<string, unknown>).issueId === "string"
  );
}

/**
 * Callback endpoint for cross-channel session-lifecycle events
 * (archive / unarchive). Emits a `response` agent activity in the
 * Linear issue so the user can see the state change without watching
 * the web app.
 */
callbacksRouter.post("/session-lifecycle", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  const payload = await c.req.json().catch(() => null);

  if (!isValidSessionLifecyclePayload(payload)) {
    log.warn("http.request", {
      trace_id: traceId,
      http_path: "/callbacks/session-lifecycle",
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
      http_path: "/callbacks/session-lifecycle",
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
      http_path: "/callbacks/session-lifecycle",
      http_status: 401,
      outcome: "rejected",
      reject_reason: "invalid_signature",
      duration_ms: Date.now() - startTime,
    });
    return c.json({ error: "unauthorized" }, 401);
  }

  c.executionCtx.waitUntil(handleSessionLifecycleCallback(payload, c.env, traceId));
  return c.json({ ok: true });
});

async function handleSessionLifecycleCallback(
  payload: SessionLifecycleCallback,
  env: Env,
  traceId: string
): Promise<void> {
  const { sessionId, event, actorAuthorId, actorDisplayName, context } = payload;
  const base = {
    trace_id: traceId,
    session_id: sessionId,
    event,
    issue_id: context.issueId,
  };

  if (!context.agentSessionId || !context.organizationId) {
    log.info("callback.session_lifecycle", {
      ...base,
      outcome: "noop",
      reason: "no_agent_session_context",
    });
    return;
  }

  const client = await getLinearClient(env, context.organizationId);
  if (!client) {
    log.warn("callback.session_lifecycle.no_oauth_token", {
      ...base,
      org_id: context.organizationId,
    });
    return;
  }

  const actor = formatCrossChannelActor(actorAuthorId, actorDisplayName);
  const verb = event === "archived" ? "archived" : "unarchived";
  const body = `Session ${verb} by ${actor}.`;

  try {
    await emitAgentActivity(client, context.agentSessionId, {
      type: "response",
      body,
    });

    log.info("callback.session_lifecycle", {
      ...base,
      outcome: "posted",
      delivery: "agent_activity",
    });
  } catch (e) {
    log.error("callback.session_lifecycle.emit_error", {
      ...base,
      error: e instanceof Error ? e : new Error(String(e)),
    });
  }
}
