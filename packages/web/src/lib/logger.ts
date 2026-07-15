import { createLogger as createStructuredLogger, parseLogLevel } from "@open-inspect/shared";

const SERVICE_NAME = "web";

export function createLogger(component: string, context: Record<string, unknown> = {}) {
  return createStructuredLogger(
    component,
    context,
    parseLogLevel(process.env.LOG_LEVEL),
    SERVICE_NAME
  );
}
