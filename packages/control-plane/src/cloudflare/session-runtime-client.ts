import { buildSessionInternalUrl } from "../session/contracts";
import type { SessionRuntimeClient } from "../session/runtime-client";

/**
 * Session runtimes as Durable Objects: each session id names one object and
 * the request travels to it over the platform's RPC.
 */
export function createDurableObjectSessionRuntimeClient(
  namespace: DurableObjectNamespace
): SessionRuntimeClient {
  return {
    fetch: (sessionId, path, init, search) =>
      namespace
        .get(namespace.idFromName(sessionId))
        .fetch(new Request(buildSessionInternalUrl(path, search), init)),
  };
}
