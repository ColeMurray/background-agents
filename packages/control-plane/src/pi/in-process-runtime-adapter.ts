import { piFeatureCapabilitySnapshotSchema } from "@open-inspect/shared/pi-runtime-feature-capabilities";
import type { InProcessHarnessRuntime } from "../harness/in-process-runtime";
import type { PiRuntimeDispatch } from "./runtime-contract";

/** Map the Pi adapter onto the harness-neutral in-process runtime port. */
export function createPiInProcessRuntime(
  dispatch: Pick<
    PiRuntimeDispatch,
    | "initialize"
    | "submit"
    | "control"
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
    submitControl: async (input) => {
      const conversationId = input.control.conversationId
        ? Number(input.control.conversationId)
        : undefined;
      const result = await dispatch.control({
        sessionId: input.sessionId,
        requestId: input.messageId,
        operationId: input.messageId,
        action: "compact",
        ...(conversationId === undefined ? {} : { conversationId }),
        ...(input.control.instructions === undefined
          ? {}
          : { instructions: input.control.instructions }),
        ...(input.executionDeadlineMs === undefined
          ? {}
          : { executionDeadlineMs: input.executionDeadlineMs }),
      });
      return {
        operationId: input.messageId,
        accepted: result.state === "accepted",
        ...(result.state === "accepted" ? {} : { rejected: "In-process control was rejected" }),
      };
    },
    lookup: (sessionId, operationId) => dispatch.lookup(sessionId, operationId),
    abort: (sessionId, operationId) => dispatch.abort(sessionId, operationId),
    preserveForArchive: (sessionId) => dispatch.preserveForArchive(sessionId),
    restoreFromArchive: (sessionId) => dispatch.restoreFromArchive(sessionId),
    destroy: (sessionId) => dispatch.destroy(sessionId),
  };
}
