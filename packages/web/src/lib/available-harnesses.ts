"use client";

import { availableHarnessIds, HARNESS_IDS, type HarnessId } from "@open-inspect/shared/harnesses";
import { useDeploymentCapabilities } from "@/hooks/use-deployment-capabilities";
import { useMemo } from "react";

export { availableHarnessIds };

/** Harnesses this deployment advertises in creation/default selectors. */
export const AVAILABLE_HARNESS_IDS: readonly HarnessId[] = availableHarnessIds(undefined);

export function useAvailableHarnessIds(): readonly HarnessId[] {
  const { data } = useDeploymentCapabilities();
  return useMemo(
    () =>
      data?.harnesses?.filter((harness) => harness.available).map((harness) => harness.id) ??
      HARNESS_IDS.filter((harness) => harness !== "pi"),
    [data]
  );
}
