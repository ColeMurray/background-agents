import type {
  PiRuntimeControl,
  PiRuntimeControlResult,
  PiRuntimeDispatch,
  PiRuntimePrompt,
} from "../pi/runtime-contract";
import type { PiSessionDO } from "./pi-durable-object";

/** Adapt the typed PI_SESSION namespace to the host-neutral Pi runtime port. */
export function createDurableObjectPiRuntimeDispatch(
  namespace: DurableObjectNamespace<PiSessionDO>
): PiRuntimeDispatch {
  const stub = (sessionId: string) => namespace.getByName(sessionId);
  const control = async (input: PiRuntimeControl): Promise<PiRuntimeControlResult> => {
    const target = stub(input.sessionId) as unknown as {
      control(value: PiRuntimeControl): Promise<PiRuntimeControlResult>;
    };
    return target.control(input);
  };
  return {
    initialize: (sessionId, snapshot) => stub(sessionId).initialize(sessionId, snapshot),
    submit: (input: PiRuntimePrompt) => stub(input.sessionId).submit(input),
    lookup: (sessionId, operationId) => stub(sessionId).lookup(sessionId, operationId),
    abort: (sessionId, operationId) => stub(sessionId).abort(sessionId, operationId),
    status: (sessionId) => stub(sessionId).status(sessionId),
    control,
    refreshDiff: (sessionId) => stub(sessionId).refreshDiff(sessionId),
    preserveForArchive: (sessionId) => stub(sessionId).preserveForArchive(sessionId),
    destroy: (sessionId) => stub(sessionId).destroy(sessionId),
  };
}
