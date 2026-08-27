import type { Logger } from "../logger";

/**
 * Wrap a logger so every line carries the session id current at emit time.
 *
 * The underlying logger snapshots its context at creation, but the session's
 * public id does not exist until `/internal/init` writes the row — a static
 * context would pin whichever id existed when the graph was built (the
 * Durable Object id, on a first-ever activation). Injecting per call through
 * a latched resolver keeps one logger for the whole graph while its
 * `session_id` upgrades the moment the row exists. Explicit per-call data can
 * still override the field, and children keep the injection.
 */
export function createSessionScopedLogger(base: Logger, getSessionId: () => string): Logger {
  const wrap = (inner: Logger): Logger => ({
    debug: (msg, data) => inner.debug(msg, { session_id: getSessionId(), ...data }),
    info: (msg, data) => inner.info(msg, { session_id: getSessionId(), ...data }),
    warn: (msg, data) => inner.warn(msg, { session_id: getSessionId(), ...data }),
    error: (msg, data) => inner.error(msg, { session_id: getSessionId(), ...data }),
    child: (context) => wrap(inner.child(context)),
  });
  return wrap(base);
}
