import { MIN_REBUILD_RUNTIME_VERSION } from "./rebuild-policy";

// A runtime the scheduler treats as current: at the rebuild floor, which is
// itself at or above the boot-compatibility floor.
export const COMPATIBLE_RUNTIME_VERSION = `v${MIN_REBUILD_RUNTIME_VERSION}-test-runtime`;

/**
 * A finalization input for a provider that returns a finished artifact from
 * one call: no operation was ever reserved, and reserving one is not part of
 * its contract. Adapters that do reserve build their own input.
 */
export function immediateFinalizationInput(input: {
  buildId: string;
  providerSessionId: string;
  correlation: { request_id: string; trace_id: string };
  signal?: AbortSignal;
}) {
  return {
    ...input,
    operation: null,
    reserveOperation: async () => {
      throw new Error("adapter reserved an operation it does not support");
    },
  };
}
