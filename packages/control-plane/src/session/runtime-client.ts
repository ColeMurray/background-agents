import type { CorrelationContext } from "../logger";
import type { Env } from "../types";
import { buildSessionInternalUrl, type SessionInternalPath } from "./contracts";

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
 * Node. The request's signal aborts the delivery as it aborts a fetch.
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
    return this.dispatch(
      sessionId,
      this.internalRequest(buildSessionInternalUrl(path, search), init)
    );
  }

  private internalRequest(url: string, init?: RequestInit): Request {
    const headers = new Headers(init?.headers);
    headers.set("x-trace-id", this.ctx.trace_id);
    headers.set("x-request-id", this.ctx.request_id);
    return new Request(url, { ...init, headers });
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
 * A client for a caller that has no request of its own, such as a runtime
 * notifying another runtime. Every call is one hop: it carries `traceId` and
 * a fresh request id, so unrelated calls never share a request identity.
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

/** The Cloudflare dispatch: the session's Durable Object stub. */
function durableObjectDispatch(env: Env): SessionRuntimeDispatch {
  return (sessionId, request) => env.SESSION.get(env.SESSION.idFromName(sessionId)).fetch(request);
}

export function createSessionRuntimeClient(
  env: Env,
  ctx: CorrelationContext
): SessionRuntimeClient {
  return createSessionRuntimeClientOver(durableObjectDispatch(env), ctx);
}

export function createSessionRuntimeClientForTrace(
  env: Env,
  traceId: string
): SessionRuntimeClient {
  return createSessionRuntimeClientForTraceOver(durableObjectDispatch(env), traceId);
}
