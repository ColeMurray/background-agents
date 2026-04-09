/**
 * Structured JSON logger for the Slack bot Cloudflare Worker.
 *
 * Delegates to the shared logger factory from @open-inspect/shared,
 * pre-binding the "slack-bot" service name so callers don't repeat it.
 */

import { createLogger as _createLogger, type LogLevel } from "@open-inspect/shared";
import type { Logger } from "@open-inspect/shared";
export type { Logger } from "@open-inspect/shared";
export type { LogLevel } from "@open-inspect/shared";
export { parseLogLevel } from "@open-inspect/shared";

const SERVICE_NAME = "slack-bot";

export function createLogger(
  component: string,
  context: Record<string, unknown> = {},
  minLevel: LogLevel = "info"
): Logger {
  return _createLogger(component, context, minLevel, SERVICE_NAME);
}
