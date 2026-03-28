/**
 * Structured JSON logger for the control-plane Cloudflare Worker.
 *
 * Delegates to the shared logger factory from @open-inspect/shared,
 * pre-binding the "control-plane" service name so callers don't repeat it.
 */

import { createLogger as _createLogger, type LogLevel } from "@open-inspect/shared";
import type { Logger } from "@open-inspect/shared";
export type { Logger } from "@open-inspect/shared";
export type { LogLevel } from "@open-inspect/shared";
export { parseLogLevel } from "@open-inspect/shared";

const SERVICE_NAME = "control-plane";

export function createLogger(
  component: string,
  context: Record<string, unknown> = {},
  minLevel: LogLevel = "info"
): Logger {
  return _createLogger(component, context, minLevel, SERVICE_NAME);
}

/**
 * Correlation context propagated through request headers.
 * Used to trace a request across service boundaries.
 */
export interface CorrelationContext {
  /** End-to-end trace ID (UUID), propagated via x-trace-id header */
  trace_id: string;
  /** Per-hop request ID (short UUID), propagated via x-request-id header */
  request_id: string;
  /** Optional session ID for deeper correlation in downstream services. */
  session_id?: string;
  /** Optional sandbox ID for sandbox-scoped operations. */
  sandbox_id?: string;
}
