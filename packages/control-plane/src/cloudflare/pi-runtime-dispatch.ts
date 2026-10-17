import type { PiRuntimeDispatch, PiRuntimePrompt } from "../pi/runtime-contract";
import type { PiSessionDO } from "./pi-durable-object";

/** Adapt the typed PI_SESSION namespace to the host-neutral Pi runtime port. */
export function createDurableObjectPiRuntimeDispatch(
  namespace: DurableObjectNamespace<PiSessionDO>
): PiRuntimeDispatch {
  const stub = (sessionId: string) => namespace.getByName(sessionId);
  return {
    submit: (input: PiRuntimePrompt) => stub(input.sessionId).submit(input),
    abort: (sessionId, operationId) => stub(sessionId).abort(sessionId, operationId),
    status: (sessionId) => stub(sessionId).status(sessionId),
  };
}
