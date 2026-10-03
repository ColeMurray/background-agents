/**
 * Callback handlers for control-plane completion notifications.
 * Uses richer response extraction and formats as Linear AgentActivities.
 */

import { Hono } from "hono";
import type { Env } from "./types";
import type { AgentResponse } from "@open-inspect/shared/types/artifacts";
import {
  linearCompletionCallbackSchema,
  linearToolCallCallbackSchema,
  type LinearCompletionCallback,
} from "@open-inspect/shared/types/session-api";
import {
  getLinearClient,
  emitAgentActivity,
  postIssueComment,
  updateAgentSession,
  fetchIssueDetails,
  fetchIssueTeamIdWithApiKey,
  type LinearApiClient,
} from "./utils/linear-client";
import { extractAgentResponse, formatAgentResponse } from "./completion/extractor";
import { resolveAppName } from "@open-inspect/shared/app-name";
import { makePlan } from "./plan";
import { createLogger } from "./logger";
import { createStartCallbackRouter } from "./callbacks/start-callback";
import { rejectInvalidCallback } from "./callbacks/reject-invalid-callback";
import { lookupIssueSession } from "./kv-store";

const log = createLogger("callback");
const EVENT_SIZE_ERROR =
  "The agent's response exceeded the event size limit and was not delivered in full.";

export function formatCompletionComment(
  appName: string,
  success: boolean,
  message: string
): string {
  return success
    ? `## 🤖 ${appName} completed\n\n${message}`
    : `## ⚠️ ${appName} encountered an issue\n\n${message}`;
}

export const callbacksRouter = new Hono<{ Bindings: Env }>();
callbacksRouter.route("/", createStartCallbackRouter());

callbacksRouter.post("/complete", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  let rawPayload: unknown;
  try {
    rawPayload = await c.req.json();
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }
  const parsed = linearCompletionCallbackSchema.safeParse(rawPayload);

  if (!parsed.success) {
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
  const payload = parsed.data;

  // Verify the original object because the signature covers its JSON key order.
  const rejection = await rejectInvalidCallback(c, rawPayload, {
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
        action: tool,
        parameter: firstStringArg ? String(firstStringArg).slice(0, 200) : "(no args)",
      };
    }
  }
}

callbacksRouter.post("/tool_call", async (c) => {
  const startTime = Date.now();
  const traceId = c.req.header("x-trace-id") || crypto.randomUUID();
  let rawPayload: unknown;
  try {
    rawPayload = await c.req.json();
  } catch {
    return c.json({ error: "invalid payload" }, 400);
  }
  const parsed = linearToolCallCallbackSchema.safeParse(rawPayload);

  if (!parsed.success) {
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
  const payload = parsed.data;

  // Verify the original object because the signature covers its JSON key order.
  const rejection = await rejectInvalidCallback(c, rawPayload, {
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

const COMPLETION_WITHHELD_MESSAGE =
  "The coding session finished, but its results cannot be shared on this issue. Open the session in Open-Inspect to review them.";

type DeliveryTeam = { linearTeamId: string } | { withheldReason: string };

/**
 * Admit completion content only for the issue's current Linear team. A signed launch team
 * is evidence of where the session started, not of where the issue lives now; legacy
 * callbacks without one fall back to the current team, whose scoped read fails closed.
 */
async function resolveDeliveryTeam(
  env: Env,
  sessionId: string,
  context: LinearCompletionCallback["context"],
  client: LinearApiClient | null
): Promise<DeliveryTeam> {
  let currentTeamId: string | null = null;
  try {
    if (client) {
      const issue = await fetchIssueDetails(client, context.issueId);
      currentTeamId = issue?.id === context.issueId ? issue.team.id.trim() || null : null;
    } else if (env.LINEAR_API_KEY) {
      currentTeamId = await fetchIssueTeamIdWithApiKey(env.LINEAR_API_KEY, context.issueId);
    }
  } catch {
    currentTeamId = null;
  }
  if (!currentTeamId) return { withheldReason: "issue_team_unverified" };

  let launchTeamId = context.linearTeamId?.trim();
  if (!launchTeamId) {
    const mapping = await lookupIssueSession(env, context.issueId);
    if (mapping?.sessionId === sessionId && mapping.issueId === context.issueId) {
      launchTeamId = mapping.linearTeamId?.trim();
    }
  }
  if (launchTeamId && launchTeamId !== currentTeamId) {
    return { withheldReason: "issue_team_changed" };
  }
  return { linearTeamId: currentTeamId };
}

async function handleCompletionCallback(
  payload: LinearCompletionCallback,
  env: Env,
  traceId?: string
): Promise<void> {
  const startTime = Date.now();
  const { sessionId, context } = payload;

  try {
    const client =
      context.organizationId && context.appUserId
        ? await getLinearClient(env, context.organizationId, context.appUserId)
        : null;
    const deliveryTeam = await resolveDeliveryTeam(env, sessionId, context, client);
    let agentResponse: AgentResponse | null = null;
    let withheldReason = "withheldReason" in deliveryTeam ? deliveryTeam.withheldReason : null;
    if ("linearTeamId" in deliveryTeam) {
      try {
        agentResponse = await extractAgentResponse(
          env,
          sessionId,
          payload.messageId,
          deliveryTeam.linearTeamId,
          traceId
        );
      } catch {
        withheldReason = "session_read_failed";
      }
    }
    if (withheldReason) {
      log.warn("callback.complete", {
        trace_id: traceId,
        session_id: sessionId,
        issue_id: context.issueId,
        outcome: "withheld",
        skip_reason: withheldReason,
        duration_ms: Date.now() - startTime,
      });
    }

    let message: string;
    let activityType: "response" | "error";

    if (!agentResponse) {
      activityType = "error";
      message = COMPLETION_WITHHELD_MESSAGE;
    } else if (payload.success) {
      activityType = "response";
      message = formatAgentResponse(agentResponse);
    } else {
      activityType = "error";
      const rawFailureReason = agentResponse.error || payload.error;
      const failureReason = rawFailureReason
        ? rawFailureReason === EVENT_SIZE_ERROR
          ? rawFailureReason
          : "Error details omitted for safety."
        : undefined;
      if (agentResponse.textContent) {
        message = `The agent encountered an error${failureReason ? `: ${failureReason}` : "."}\n\n${agentResponse.textContent.slice(0, 500)}`;
      } else {
        message = failureReason
          ? `The agent encountered an error: ${failureReason}`
          : "The agent was unable to complete this task.";
      }
    }

    // Emit via Agent API if we have session context
    if (context.agentSessionId && context.organizationId && context.appUserId) {
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
          plan: makePlan(payload.success && agentResponse ? "completed" : "failed"),
        });

        // Update externalUrls with PR link if available
        const prArtifact = agentResponse?.artifacts.find((a) => a.type === "pr" && a.url);
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
          has_pr: Boolean(prArtifact),
          agent_success: payload.success,
          tool_call_count: agentResponse?.toolCalls.length ?? 0,
          artifact_count: agentResponse?.artifacts.length ?? 0,
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
