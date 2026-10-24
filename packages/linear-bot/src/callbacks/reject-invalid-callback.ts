import type { Context } from "hono";
import { getCallbackAuthRejection } from "@open-inspect/shared/callback-auth";
import type { Env } from "../types";
import { createLogger } from "../logger";

const log = createLogger("callback");

/**
 * Shared rejection guard for signed callback routes: require the signing
 * secret, then verify the in-body HMAC signature. Returns a Response to
 * short-circuit on any failure, or null when the request is authentic and
 * the caller may proceed. Every route passes `logContext` so rejections are
 * observable; parsing stays in each route so the caller controls how a
 * malformed body is surfaced.
 */
export async function rejectInvalidCallback(
  c: Context<{ Bindings: Env }>,
  payload: unknown,
  logContext?: { path: string; traceId: string; startTime: number; sessionId?: string }
): Promise<Response | null> {
  const rejection = await getCallbackAuthRejection(payload, c.env);
  if (!rejection) return null;
  if (logContext) {
    const fields = {
      trace_id: logContext.traceId,
      http_path: logContext.path,
      http_status: rejection.status,
      outcome: rejection.status === 500 ? "error" : "rejected",
      reject_reason: rejection.reason,
      ...(rejection.status === 401 && logContext.sessionId !== undefined
        ? { session_id: logContext.sessionId }
        : {}),
      duration_ms: Date.now() - logContext.startTime,
    };
    if (rejection.status === 500) log.error("http.request", fields);
    else log.warn("http.request", fields);
  }
  return c.json({ error: rejection.error }, rejection.status);
}
