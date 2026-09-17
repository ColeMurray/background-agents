import type { CorrelationContext } from "../logger";
import type { Env } from "../types";
import { buildSessionInternalRequest, type SessionInternalPath } from "./contracts";

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
 * Delivers one internal request to the session's runtime, however the host
 * reaches it: a Durable Object stub on Cloudflare, the runtime registry on
 * Node. The platform record carries the host's as `SESSION`. The request's
 * signal aborts the delivery as it aborts a fetch.
 */
export type SessionRuntimeDispatch = (sessionId: string, request: Request) => Promise<Response>;

class DispatchingSessionRuntimeClient implements SessionRuntimeClient {
  constructor(
    private readonly dispatch: SessionRuntimeDispatch,
    private readonly ctx: CorrelationContext
  ) {}

  fetch(
    sessionId: string,
    path: SessionInternalPath,
    init?: RequestInit,
    search?: string
  ): Promise<Response> {
    const headers = new Headers(init?.headers);
    headers.set("x-trace-id", this.ctx.trace_id);
    headers.set("x-request-id", this.ctx.request_id);
    return this.dispatch(
      sessionId,
      buildSessionInternalRequest(path, { ...init, headers }, search)
    );
  }
}

/** A client for the caller's own request, correlated with `ctx`, over `dispatch`. */
export function createSessionRuntimeClientOver(
  dispatch: SessionRuntimeDispatch,
  ctx: CorrelationContext
): SessionRuntimeClient {
  return new DispatchingSessionRuntimeClient(dispatch, ctx);
}

/**
 * A client over `dispatch` for a caller that has no request of its own, such
 * as a runtime notifying another runtime. Every call is one hop: it carries
 * `traceId` and a fresh request id, so unrelated calls never share a request
 * identity.
 */
export function createSessionRuntimeClientForTraceOver(
  dispatch: SessionRuntimeDispatch,
  traceId: string
): SessionRuntimeClient {
  return {
    fetch: (sessionId, path, init, search) =>
      createSessionRuntimeClientOver(dispatch, {
        trace_id: traceId,
        request_id: crypto.randomUUID(),
      }).fetch(sessionId, path, init, search),
  };
}

/**
 * The platform's session client with `ctx` on every request as the
 * `x-trace-id` and `x-request-id` headers the runtime's request log reads.
 */
export function createSessionRuntimeClient(
  env: Env,
  ctx: CorrelationContext
): SessionRuntimeClient {
  return createSessionRuntimeClientOver(env.SESSION, ctx);
}

/** The platform's session client for a caller without a request of its own; see `createSessionRuntimeClientForTraceOver`. */
export function createSessionRuntimeClientForTrace(
  env: Env,
  traceId: string
): SessionRuntimeClient {
  return createSessionRuntimeClientForTraceOver(env.SESSION, traceId);
}
