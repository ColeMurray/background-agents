import type { Logger } from "../logger";

/**
 * A child of the session logger carrying the request's trace and request
 * ids. Returns the session logger itself when the request carries neither,
 * and never mutates it: request correlation must not leak into the callbacks
 * the session logger serves later.
 */
export function requestLogger(sessionLog: Logger, request: Request): Logger {
  const traceId = request.headers.get("x-trace-id");
  const requestId = request.headers.get("x-request-id");
  if (!traceId && !requestId) return sessionLog;

  const correlationContext: Record<string, unknown> = {};
  if (traceId) correlationContext.trace_id = traceId;
  if (requestId) correlationContext.request_id = requestId;
  return sessionLog.child(correlationContext);
}
