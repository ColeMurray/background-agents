import type { CorrelationContext } from "../logger";
import type { Env } from "../types";
import type { SessionInternalPath } from "./contracts";

/** Reach one session's runtime by session id, wherever the host keeps it. */
export interface SessionRuntimeClient {
  fetch(
    sessionId: string,
    path: SessionInternalPath,
    init?: RequestInit,
    search?: string
  ): Promise<Response>;
}

/**
 * The platform's session client with `ctx` on every request as the
 * `x-trace-id` and `x-request-id` headers the runtime's request log reads.
 */
export function createSessionRuntimeClient(
  env: Env,
  ctx: CorrelationContext
): SessionRuntimeClient {
  return {
    fetch: (sessionId, path, init, search) => {
      const headers = new Headers(init?.headers);
      headers.set("x-trace-id", ctx.trace_id);
      headers.set("x-request-id", ctx.request_id);
      return env.SESSION.fetch(sessionId, path, { ...init, headers }, search);
    },
  };
}

/**
 * A client for a caller that has no request of its own, such as a runtime
 * notifying another runtime. Every call is one hop: it carries `traceId` and
 * a fresh request id, so unrelated calls never share a request identity.
 */
export function createSessionRuntimeClientForTrace(
  env: Env,
  traceId: string
): SessionRuntimeClient {
  return {
    fetch: (sessionId, path, init, search) =>
      createSessionRuntimeClient(env, {
        trace_id: traceId,
        request_id: crypto.randomUUID(),
      }).fetch(sessionId, path, init, search),
  };
}
