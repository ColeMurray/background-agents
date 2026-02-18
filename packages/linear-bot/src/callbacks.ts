/**
 * Callback handlers for control-plane notifications.
 * When a session completes, this posts a comment back on the Linear issue.
 */

import { Hono } from "hono";
import type { Env, CompletionCallback } from "./types";
import { postIssueComment } from "./utils/linear-client";
import { createLogger } from "./logger";

const log = createLogger("callback");

/**
 * Verify internal callback signature using shared secret.
 */
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

/**
 * Callback endpoint for session completion notifications.
 */
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

/**
 * Handle completion callback — post result as a Linear comment.
 */
async function handleCompletionCallback(
  payload: CompletionCallback,
  env: Env,
  traceId?: string
): Promise<void> {
  const startTime = Date.now();
  const { sessionId, context } = payload;

  try {
    // Fetch artifacts (PRs) from the session
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (env.INTERNAL_CALLBACK_SECRET) {
      const { generateInternalToken } = await import("./utils/internal");
      const authToken = await generateInternalToken(env.INTERNAL_CALLBACK_SECRET);
      headers["Authorization"] = `Bearer ${authToken}`;
    }
    if (traceId) headers["x-trace-id"] = traceId;

    const artifactsRes = await env.CONTROL_PLANE.fetch(
      `https://internal/sessions/${sessionId}/artifacts`,
      { method: "GET", headers }
    );

    let prUrl: string | null = null;
    if (artifactsRes.ok) {
      const data = (await artifactsRes.json()) as {
        artifacts: Array<{ type: string; url: string | null }>;
      };
      const prArtifact = data.artifacts.find((a) => a.type === "pull_request" && a.url);
      if (prArtifact) prUrl = prArtifact.url;
    }

    // Build the comment
    let comment: string;
    if (payload.success && prUrl) {
      comment = [
        `## 🤖 Open-Inspect completed`,
        ``,
        `Pull request opened: ${prUrl}`,
        ``,
        `[View session](${env.WEB_APP_URL}/session/${sessionId})`,
      ].join("\n");
    } else if (payload.success) {
      comment = [
        `## 🤖 Open-Inspect completed`,
        ``,
        `The agent finished working on this issue.`,
        ``,
        `[View session](${env.WEB_APP_URL}/session/${sessionId})`,
      ].join("\n");
    } else {
      comment = [
        `## ⚠️ Open-Inspect encountered an issue`,
        ``,
        `The agent was unable to complete this task.`,
        ``,
        `[View session for details](${env.WEB_APP_URL}/session/${sessionId})`,
      ].join("\n");
    }

    const result = await postIssueComment(env.LINEAR_API_KEY, context.issueId, comment);

    log.info("callback.complete", {
      trace_id: traceId,
      session_id: sessionId,
      issue_id: context.issueId,
      issue_identifier: context.issueIdentifier,
      outcome: result.success ? "success" : "error",
      has_pr: Boolean(prUrl),
      agent_success: payload.success,
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
