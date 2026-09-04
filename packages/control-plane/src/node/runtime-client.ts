/**
 * The Node host's `SessionRuntimeClient`: a session's runtime lives in this
 * process, inside the runtime registry, so a call is a leased method call
 * on it rather than a Durable Object stub's RPC. The request carries the
 * same internal URL and correlation headers the Cloudflare client sends, so
 * the session's HTTP dispatcher sees one shape on both hosts.
 *
 * A session that has neither an index row nor a store on this host answers
 * 404 without a runtime being opened: opening would create an empty store
 * for a session that does not exist, and callers such as the draft sweep
 * treat 404 as the definitive answer that nothing is behind the id. A
 * session with an index row and no store yet is the one being created; its
 * init request opens the store.
 *
 * Re-entrancy rule: a runtime never calls its own session through this
 * client. On the Durable Object such a call would block on the input gate;
 * here it re-enters the runtime synchronously under a second lease. No
 * runtime does this today, and the concurrency model (H-3) records the rule.
 *
 * The lease covers the handler, not the response body: a body read after
 * `fetch` resolves runs outside it, as a stub's response does on Cloudflare.
 */

import type { CorrelationContext } from "../logger";
import { buildSessionInternalUrl, type SessionInternalPath } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";
import type { SessionStoreProvider } from "./session-store";

/** What the client needs of a runtime: the session's request entry point. */
export interface RequestServingRuntime {
  readonly server: { onRequest(request: Request): Promise<Response> };
}

/** Leased access to a session's runtime; `SessionRuntimeRegistry` satisfies it. */
interface SessionRuntimeLookup<Runtime extends RequestServingRuntime> {
  withRuntime<T>(sessionId: string, use: (runtime: Runtime) => Promise<T>): Promise<T>;
}

export interface NodeSessionRuntimeClientOptions<Runtime extends RequestServingRuntime> {
  runtimes: SessionRuntimeLookup<Runtime>;
  /** The deployment's session index; `SessionIndexStore` satisfies it. */
  sessionIndex: { exists(sessionId: string): Promise<boolean> };
  storeProvider: Pick<SessionStoreProvider, "exists">;
}

class NodeSessionRuntimeClient<
  Runtime extends RequestServingRuntime,
> implements SessionRuntimeClient {
  constructor(
    private readonly options: NodeSessionRuntimeClientOptions<Runtime>,
    private readonly ctx: CorrelationContext
  ) {}

  async fetch(
    sessionId: string,
    path: SessionInternalPath,
    init?: RequestInit,
    search?: string
  ): Promise<Response> {
    if (!(await this.exists(sessionId))) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    const request = this.internalRequest(buildSessionInternalUrl(path, search), init);
    return this.options.runtimes.withRuntime(sessionId, (runtime) =>
      runtime.server.onRequest(request)
    );
  }

  private async exists(sessionId: string): Promise<boolean> {
    const { sessionIndex, storeProvider } = this.options;
    return (await storeProvider.exists(sessionId)) || (await sessionIndex.exists(sessionId));
  }

  private internalRequest(url: string, init?: RequestInit): Request {
    const headers = new Headers(init?.headers);
    headers.set("x-trace-id", this.ctx.trace_id);
    headers.set("x-request-id", this.ctx.request_id);
    return new Request(url, { ...init, headers });
  }
}

export function createNodeSessionRuntimeClient<Runtime extends RequestServingRuntime>(
  options: NodeSessionRuntimeClientOptions<Runtime>,
  ctx: CorrelationContext
): SessionRuntimeClient {
  return new NodeSessionRuntimeClient(options, ctx);
}

/**
 * A client for a caller that has no request of its own, such as a runtime
 * notifying another runtime. Every call is one hop: it carries `traceId` and
 * a fresh request id, so unrelated calls never share a request identity.
 */
export function createNodeSessionRuntimeClientForTrace<Runtime extends RequestServingRuntime>(
  options: NodeSessionRuntimeClientOptions<Runtime>,
  traceId: string
): SessionRuntimeClient {
  return {
    fetch: (sessionId, path, init, search) =>
      createNodeSessionRuntimeClient(options, {
        trace_id: traceId,
        request_id: crypto.randomUUID(),
      }).fetch(sessionId, path, init, search),
  };
}
