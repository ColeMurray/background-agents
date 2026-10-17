import { availableHarnessIds, type HarnessId } from "@open-inspect/shared/harnesses";

export { availableHarnessIds };

/** Harnesses this deployment advertises in creation/default selectors. */
export const AVAILABLE_HARNESS_IDS: readonly HarnessId[] = availableHarnessIds(
  process.env.NEXT_PUBLIC_PI_DURABLE_ENABLED
);
