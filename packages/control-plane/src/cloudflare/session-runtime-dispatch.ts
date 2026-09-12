import type { SessionRuntimeDispatch } from "../session/runtime-client";

/**
 * Session runtimes as Durable Objects: each session id names one object and
 * the request travels to it over the platform's RPC.
 */
export function createDurableObjectSessionRuntimeDispatch(
  namespace: DurableObjectNamespace
): SessionRuntimeDispatch {
  return (sessionId, request) => namespace.get(namespace.idFromName(sessionId)).fetch(request);
}
