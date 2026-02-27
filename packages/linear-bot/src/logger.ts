/**
 * Structured JSON logger for the Linear bot Cloudflare Worker.
 * Same contract as the control-plane and slack-bot loggers.
 */

import type { Logger } from "@open-inspect/shared";
export type { Logger } from "@open-inspect/shared";

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

const RESERVED_KEYS = new Set(["level", "component", "msg", "ts", "service", "event"]);

const CONSOLE_METHOD: Record<LogLevel, "log" | "warn" | "error"> = {
  debug: "log",
  info: "log",
  warn: "warn",
  error: "error",
};

function stripReserved(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!RESERVED_KEYS.has(key)) out[key] = obj[key];
  }
  return out;
}

export function createLogger(
  component: string,
  context: Record<string, unknown> = {},
  minLevel: LogLevel = "info"
): Logger {
  const safeContext = stripReserved(context);

  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;

    const extra: Record<string, unknown> = data ? stripReserved(data) : {};
    if (extra.error instanceof Error) {
      const err = extra.error;
      extra.error_message = err.message;
      extra.error_stack = err.stack;
      extra.error_type = err.constructor.name;
      delete extra.error;
    }

    try {
      console[CONSOLE_METHOD[level]](
        JSON.stringify({
          level,
          service: "linear-bot",
          component,
          msg,
          ...safeContext,
          ...extra,
          ts: Date.now(),
        })
      );
    } catch {
      console.error(
        JSON.stringify({
          level: "error",
          service: "linear-bot",
          component,
          msg: "LOG_SERIALIZE_FAILURE",
          original_msg: msg,
          original_level: level,
          ts: Date.now(),
        })
      );
    }
  };

  return {
    debug: (msg, data) => emit("debug", msg, data),
    info: (msg, data) => emit("info", msg, data),
    warn: (msg, data) => emit("warn", msg, data),
    error: (msg, data) => emit("error", msg, data),
    child: (childCtx) =>
      createLogger(component, { ...safeContext, ...stripReserved(childCtx) }, minLevel),
  };
}
