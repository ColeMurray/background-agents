/**
 * Callback handlers for control-plane completion notifications.
 * Uses richer response extraction and formats as Linear AgentActivities.
 */

import { Hono } from "hono";
import type { Env, CompletionCallback, ToolCallCallback } from "./types";
import {
  getLinearClient,
  emitAgentActivity,
  postIssueComment,
  updateAgentSession,
} from "./utils/linear-client";
import { extractAgentResponse, formatAgentResponse } from "./completion/extractor";
import { resolveAppName } from "@open-inspect/shared";
import { makePlan } from "./plan";
import { createLogger } from "./logger";
import { createStartCallbackRouter } from "./callbacks/start-callback";
import { rejectInvalidCallback } from "./callbacks/reject-invalid-callback";

const log = createLogger("callback");

export function formatCompletionComment(
  appName: string,
  success: boolean,
  message: string
): string {
  return success
    ? `## 🤖 ${appName} completed\n\n${message}`
    : `## ⚠️ ${appName} encountered an issue\n\n${message}`;
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
callbacksRouter.route("/", createStartCallbackRouter());

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

  const rejection = await rejectInvalidCallback(c, payload, {
    path: "/callbacks/complete",
    traceId,
    startTime,
  });
  if (rejection) return rejection;

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

  const rejection = await rejectInvalidCallback(c, payload, {
    path: "/callbacks/tool_call",
    traceId,
    startTime,
    sessionId: payload.sessionId,
  });
  if (rejection) return rejection;

  c.executionCtx.waitUntil(
    (async () => {
      const processStart = Date.now();
      const { context } = payload;

      if (!context.agentSessionId || !context.organizationId || !context.appUserId) {
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

      const client = await getLinearClient(c.env, context.organizationId, context.appUserId);
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

    let message: string;
    let activityType: "response" | "error";

    if (payload.success) {
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
    if (context.agentSessionId && context.organizationId && context.appUserId) {
      const client = await getLinearClient(env, context.organizationId, context.appUserId);
      if (client) {
        const activityDelivered = await emitAgentActivity(client, context.agentSessionId, {
          type: activityType,
          body: message,
        });
        if (!activityDelivered) {
          log.error("callback.complete", {
            trace_id: traceId,
            session_id: sessionId,
            issue_id: context.issueId,
            issue_identifier: context.issueIdentifier,
            agent_session_id: context.agentSessionId,
            outcome: "error",
            agent_success: payload.success,
            delivery: "agent_activity",
            delivery_outcome: "error",
            duration_ms: Date.now() - startTime,
          });
          return;
        }

        // Update plan to completed/failed
        await updateAgentSession(client, context.agentSessionId, {
          plan: makePlan(payload.success ? "completed" : "failed"),
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
