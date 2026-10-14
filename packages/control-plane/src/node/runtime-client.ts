/**
 * The Node host's `SessionRuntimeDispatch`: a session's runtime lives in
 * this process, inside the runtime registry, so a request is a leased
 * method call on it rather than a Durable Object stub's RPC. Request
 * construction and correlation stay in `session/runtime-client.ts`; this
 * module is only the delivery.
 *
 * A session the registry finds nothing behind (no store on this host, no
 * index row) answers 404 without a runtime being opened; the draft sweep
 * relies on 404 as the definitive answer that nothing is behind the id.
 *
 * The request's signal aborts the delivery as it aborts a fetch: the
 * caller's promise rejects with the signal's reason at once, while the
 * handler already running keeps its lease until it settles, so an aborted
 * request cannot leave the registry holding a runtime open for a caller
 * that has gone.
 *
 * Re-entrancy rule: a runtime never calls its own session through the
 * client. On the Durable Object such a call would block on the input gate;
 * here it re-enters the runtime under a second lease. No runtime does this
 * today, and the concurrency model (H-3) records the rule.
 */

import type { SessionRuntimeDispatch } from "../session/runtime-client";

/** What the dispatch needs of a runtime: the session's request entry point. */
export interface RequestServingRuntime {
  readonly server: { onRequest(request: Request): Promise<Response> };
}

/** Leased access to an existing session's runtime; `SessionRuntimeRegistry` satisfies it. */
export interface SessionRuntimeLookup<Runtime> {
  withRuntimeIfPresent<T>(
    sessionId: string,
    use: (runtime: Runtime) => Promise<T>
  ): Promise<T | undefined>;
}

export function createNodeSessionRuntimeDispatch<Runtime extends RequestServingRuntime>(
  runtimes: SessionRuntimeLookup<Runtime>
): SessionRuntimeDispatch {
  return (sessionId, request) =>
    untilAborted(request.signal, async () => {
      const response = await runtimes.withRuntimeIfPresent(sessionId, (runtime) =>
        runtime.server.onRequest(request)
      );
      return response ?? Response.json({ error: "Session not found" }, { status: 404 });
    });
}

/**
 * `run`, rejected with the signal's reason as soon as it aborts. A signal
 * already aborted rejects before `run` starts; otherwise `run` continues
 * to its own end, and its outcome is dropped once the abort has won.
 */
function untilAborted<T>(signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  if (!signal) return run();
  if (signal.aborted) return Promise.reject(signal.reason as Error);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason as Error);
    signal.addEventListener("abort", onAbort, { once: true });
    run()
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", onAbort));
  });
}
