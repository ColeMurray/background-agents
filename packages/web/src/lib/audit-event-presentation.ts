import type { AuditEvent, AuditOperationResult } from "@open-inspect/shared/types/audit-events";

const AUTHORIZATION_DECISION_SCHEMA = "authorization_decision.v1";

const AUTHORIZATION_DECISIONS = new Map<string, "allowed" | "denied">([
  ["authorization.request_allowed", "allowed"],
  ["authorization.request_denied", "denied"],
]);

const HTTP_STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  409: "Conflict",
  410: "Gone",
  412: "Precondition Failed",
  413: "Content Too Large",
  415: "Unsupported Media Type",
  422: "Unprocessable Content",
  429: "Too Many Requests",
  500: "Internal Server Error",
  501: "Not Implemented",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/**
 * How an audit row should be read.
 *
 * - `authorization`: a route admission decision. It records whether the request was permitted and
 *   the HTTP status the handler returned; it never establishes a domain effect, even on 2xx.
 * - `unclassified-authorization`: authorization-shaped, but not a decision this client recognizes.
 * - `operation`: written by the operation owner, so its result describes the domain outcome.
 *
 * `httpStatus` is `null` when the row has no valid recorded status (for example, legacy rows).
 */
export type AuditEventPresentation =
  | { kind: "authorization"; decision: "allowed" | "denied"; httpStatus: number | null }
  | { kind: "unclassified-authorization"; httpStatus: number | null }
  | { kind: "operation"; result: AuditOperationResult };

function recordedHttpStatus(metadata: AuditEvent["metadata"]): number | null {
  const status = metadata.httpStatus;
  return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : null;
}

/** Classifies an audit row by its action and schema; `operationResult` alone is never enough. */
export function presentAuditEvent(
  event: Pick<AuditEvent, "action" | "operationResult" | "metadata">
): AuditEventPresentation {
  const schema = event.metadata.schema;
  const authorizationShaped =
    event.action.startsWith("authorization.") || schema === AUTHORIZATION_DECISION_SCHEMA;
  if (!authorizationShaped) return { kind: "operation", result: event.operationResult };

  const httpStatus = recordedHttpStatus(event.metadata);
  const decision = AUTHORIZATION_DECISIONS.get(event.action);
  // Legacy rows predate the schema marker; any other schema is not a decision we understand.
  if (decision && (schema === undefined || schema === AUTHORIZATION_DECISION_SCHEMA)) {
    return { kind: "authorization", decision, httpStatus };
  }
  return { kind: "unclassified-authorization", httpStatus };
}

/** Formats a recorded status such as `HTTP 409 Conflict`. */
export function formatHttpStatus(status: number): string {
  const text = HTTP_STATUS_TEXT[status];
  return text ? `HTTP ${status} ${text}` : `HTTP ${status}`;
}
