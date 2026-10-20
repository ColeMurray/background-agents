/**
 * Trace correlation for Pi operations.
 *
 * A Pi operation is identified by the Open-Inspect message id, which both the
 * SessionDO and the PiSessionDO already share. Deriving the trace id from it
 * keeps every hop of one operation on one trace, survives a retry, and adds
 * no new persisted state.
 *
 * The value carries no user content: it is an identifier, not a payload.
 */

const TRACE_ID_PREFIX = "pi-";
const MAX_TRACE_ID_LENGTH = 128;

/** The trace id for one Pi operation. */
export function piTraceId(operationId: string): string {
  const normalized = operationId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, MAX_TRACE_ID_LENGTH);
  return `${TRACE_ID_PREFIX}${normalized}`;
}

/** The `x-trace-id` header value for one Pi operation, when it is known. */
export function piTraceHeader(operationId: string | undefined): Record<string, string> {
  return operationId === undefined ? {} : { "x-trace-id": piTraceId(operationId) };
}
