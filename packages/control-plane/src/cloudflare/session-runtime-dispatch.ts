import type { Logger } from "../logger";
import type { SessionRuntimeDispatch } from "../session/runtime-client";

export function parseSessionDoLocationHint(
  value: string | undefined,
  log: Pick<Logger, "warn">
): DurableObjectLocationHint | undefined {
  switch (value) {
    case undefined:
    case "":
      return undefined;
    case "wnam":
    case "enam":
    case "sam":
    case "weur":
    case "eeur":
    case "apac":
    case "apac-ne":
    case "apac-se":
    case "oc":
    case "afr":
    case "me":
      return value;
    default:
      log.warn("Ignoring invalid SESSION_DO_LOCATION_HINT", {
        event: "session_do.invalid_location_hint",
      });
      return undefined;
  }
}

/**
 * Session runtimes as Durable Objects: each session id names one object and
 * the request travels to it over the platform's RPC.
 */
export function createDurableObjectSessionRuntimeDispatch(
  namespace: DurableObjectNamespace,
  { locationHint }: { locationHint?: DurableObjectLocationHint } = {}
): SessionRuntimeDispatch {
  return (sessionId, request) => {
    const id = namespace.idFromName(sessionId);
    const stub = locationHint ? namespace.get(id, { locationHint }) : namespace.get(id);
    return stub.fetch(request);
  };
}
