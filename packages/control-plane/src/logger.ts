/**
 * Structured JSON logger for Cloudflare Workers.
 *
 * Outputs flat JSON lines which Cloudflare Workers Logs automatically indexes
 * for querying. Zero external dependencies.
 *
 * - Uses console.warn/console.error for severity semantics in tooling/alerts,
 *   while keeping the JSON `level` field for programmatic filtering.
 * - JSON.stringify is wrapped in try/catch so a logging failure never crashes
 *   a request or Durable Object event.
 * - Reserved keys (`level`, `component`, `msg`, `ts`) cannot be overwritten
 *   by context or data — they are always set by the logger itself.
 *
 * Usage:
 *   const log = createLogger("worker");
 *   log.info("Request received", { method: "GET", path: "/health" });
 *   const child = log.child({ sessionId: "abc123" });
 *   child.info("Session started");
 */

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

/** Keys that the logger owns — context and data cannot overwrite these. */
const RESERVED_KEYS = new Set(["level", "component", "msg", "ts"]);

/** Map log level to the appropriate console method for severity semantics. */
const CONSOLE_METHOD: Record<LogLevel, "log" | "warn" | "error"> = {
  debug: "log",
  info: "log",
  warn: "warn",
  error: "error",
};

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(context: Record<string, unknown>): Logger;
}

/** Strip reserved keys from a record so callers cannot overwrite logger-owned fields. */
function stripReserved(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj)) {
    if (!RESERVED_KEYS.has(key)) {
      out[key] = obj[key];
    }
  }
  return out;
}

export function createLogger(
  component: string,
  context: Record<string, unknown> = {},
  minLevel: LogLevel = "info"
): Logger {
  // Pre-strip reserved keys from the base context once at creation time.
  const safeContext = stripReserved(context);

  const emit = (level: LogLevel, msg: string, data?: Record<string, unknown>) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;

    const extra: Record<string, unknown> = data ? stripReserved(data) : {};
    if (extra.error instanceof Error) {
      extra.errorMessage = extra.error.message;
      extra.errorStack = extra.error.stack;
      delete extra.error;
    }

    try {
      console[CONSOLE_METHOD[level]](
        JSON.stringify({
          level,
          component,
          msg,
          ...safeContext,
          ...extra,
          ts: Date.now(),
        })
      );
    } catch {
      // Fallback for bigint, circular references, or other stringify failures.
      // Use a guaranteed-serializable line so we never lose the event entirely.
      console.error(
        JSON.stringify({
          level: "error",
          component,
          msg: "LOG_SERIALIZE_FAILURE",
          originalMsg: msg,
          originalLevel: level,
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

/**
 * Parse a LOG_LEVEL env var string into a valid LogLevel, defaulting to "info".
 * Uses an explicit allowlist to avoid matching Object prototype keys.
 */
export function parseLogLevel(value?: string): LogLevel {
  if (value && Object.prototype.hasOwnProperty.call(LEVELS, value)) return value as LogLevel;
  return "info";
}
