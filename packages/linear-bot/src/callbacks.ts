/**
 * Callback handlers for control-plane completion notifications.
 * Uses richer response extraction and formats as Linear AgentActivities.
 */

import { Hono } from "hono";
import type { Env, CompletionCallback } from "./types";
import {
  getLinearClient,
  emitAgentActivity,
  postIssueComment,
  updateAgentSession,
} from "./utils/linear-client";
import { extractAgentResponse, formatAgentResponse } from "./completion/extractor";
import { createLogger } from "./logger";

const log = createLogger("callback");

async function verifyCallbackSignature(
  payload: CompletionCallback,
  secret: string
): Promise<boolean> {
  const { signature, ...data } = payload;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureData = encoder.encode(JSON.stringify(data));
  const expectedSig = await crypto.subtle.sign("HMAC", key, signatureData);
  const expectedHex = Array.from(new Uint8Array(expectedSig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return signature === expectedHex;
}

function isValidPayload(payload: unknown): payload is CompletionCallback {
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
      message = formatAgentResponse(agentResponse, sessionId, env.WEB_APP_URL);
    } else {
      activityType = "error";
      if (agentResponse.textContent) {
        message = `The agent encountered an error.\n\n${agentResponse.textContent.slice(0, 500)}\n\n[View session](${env.WEB_APP_URL}/session/${sessionId})`;
      } else {
        message = `The agent was unable to complete this task.\n\n[View session for details](${env.WEB_APP_URL}/session/${sessionId})`;
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
          outcome: "success",
          has_pr: agentResponse.artifacts.some((a) => a.type === "pr" && a.url),
          agent_success: payload.success,
          tool_call_count: agentResponse.toolCalls.length,
          artifact_count: agentResponse.artifacts.length,
          delivery: "agent_activity",
          duration_ms: Date.now() - startTime,
        });
        return;
      }
      log.warn("callback.no_oauth_token", {
        trace_id: traceId,
        org_id: context.organizationId,
      });
    }

    // Fallback: post a comment
    const commentBody = payload.success
      ? `## 🤖 Open-Inspect completed\n\n${message}`
      : `## ⚠️ Open-Inspect encountered an issue\n\n${message}`;

    const result = await postIssueComment(env.LINEAR_API_KEY, context.issueId, commentBody);

    log.info("callback.complete", {
      trace_id: traceId,
      session_id: sessionId,
      issue_id: context.issueId,
      outcome: result.success ? "success" : "error",
      agent_success: payload.success,
      delivery: "comment_fallback",
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
