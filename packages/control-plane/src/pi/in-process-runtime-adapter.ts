import { piFeatureCapabilitySnapshotSchema } from "@open-inspect/shared/pi-runtime-feature-capabilities";
import type { InProcessHarnessRuntime } from "../harness/in-process-runtime";
import type { PiRuntimeDispatch } from "./runtime-contract";

/** Map the Pi adapter onto the harness-neutral in-process runtime port. */
export function createPiInProcessRuntime(
  dispatch: Pick<
    PiRuntimeDispatch,
    | "initialize"
    | "submit"
    | "lookup"
    | "abort"
    | "preserveForArchive"
    | "restoreFromArchive"
    | "destroy"
  >
): InProcessHarnessRuntime {
  return {
    harness: "pi",
    initialize: (sessionId, snapshot) =>
      dispatch.initialize(sessionId, piFeatureCapabilitySnapshotSchema.parse(snapshot)),
    submit: (input) => dispatch.submit(input),
    lookup: (sessionId, operationId) => dispatch.lookup(sessionId, operationId),
    abort: (sessionId, operationId) => dispatch.abort(sessionId, operationId),
    preserveForArchive: (sessionId) => dispatch.preserveForArchive(sessionId),
    restoreFromArchive: (sessionId) => dispatch.restoreFromArchive(sessionId),
    destroy: (sessionId) => dispatch.destroy(sessionId),
  };
}
