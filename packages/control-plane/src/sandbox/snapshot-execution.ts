import {
  sandboxExecutionProfileSchema,
  type SessionSandboxExecution,
  type SnapshotRecoveryErrorCode,
} from "@open-inspect/shared/types/sandbox-execution";
import { parseRuntimeVersionNumber } from "../image-builds/model";
import {
  EXECUTION_PROFILE_MIN_RUNTIME_GENERATION,
  MIN_COMPATIBLE_RUNTIME_GENERATION,
} from "./runtime-manifest";

/** Missing labels belong exclusively to the legacy/default image family. */
export function snapshotExecutionIssue(
  execution: SessionSandboxExecution,
  snapshotProfile: string | null | undefined,
  runtimeVersion: string | null | undefined
): SnapshotRecoveryErrorCode | null {
  const profile = sandboxExecutionProfileSchema.safeParse(snapshotProfile ?? "default");
  if (!profile.success) return "invalid_snapshot_metadata";
  if (profile.data !== execution.profile) return "profile_mismatch";
  if (
    execution.profile === "docker-v1" &&
    (parseRuntimeVersionNumber(runtimeVersion ?? "") ?? 0) <
      Math.max(
        MIN_COMPATIBLE_RUNTIME_GENERATION,
        EXECUTION_PROFILE_MIN_RUNTIME_GENERATION["docker-v1"]
      )
  ) {
    return "runtime_incompatible";
  }
  return null;
}
