import type { Context } from "hono";
import { verifyCallbackFromControlPlane } from "@open-inspect/shared";
import type { Env } from "../types";
import { createLogger } from "../logger";

const log = createLogger("callback");

/**
 * Shared rejection guard for signed callback routes: require the signing
 * secret, then verify the in-body HMAC signature. Returns a Response to
 * short-circuit on any failure, or null when the request is authentic and
 * the caller may proceed. Routes that log rejections pass `logContext`
 * (the start callback rejects silently and omits it); parsing stays in
 * each route so the caller controls how a malformed body is surfaced.
 */
export async function rejectInvalidCallback(
  c: Context<{ Bindings: Env }>,
  payload: { signature: string },
  logContext?: { path: string; traceId: string; startTime: number; sessionId?: string }
): Promise<Response | null> {
  if (!c.env.SERVICE_AUTH_SECRET) {
    if (logContext) {
      log.error("http.request", {
        trace_id: logContext.traceId,
        http_path: logContext.path,
        http_status: 500,
        outcome: "error",
        reject_reason: "secret_not_configured",
        duration_ms: Date.now() - logContext.startTime,
      });
    }
    return c.json({ error: "not configured" }, 500);
  }

  const authentic = await verifyCallbackFromControlPlane(payload, c.env);
  if (!authentic) {
    if (logContext) {
      log.warn("http.request", {
        trace_id: logContext.traceId,
        http_path: logContext.path,
        http_status: 401,
        outcome: "rejected",
        reject_reason: "invalid_signature",
        ...(logContext.sessionId !== undefined ? { session_id: logContext.sessionId } : {}),
        duration_ms: Date.now() - logContext.startTime,
      });
    }
    return c.json({ error: "unauthorized" }, 401);
  }

  return null;
}
