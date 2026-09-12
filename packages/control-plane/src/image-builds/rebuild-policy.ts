import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import { parseRuntimeVersionNumber, type ImageBuildProvider } from "./model";
import { repositoryIdentityKey } from "./provenance";
import type { EnabledScopeUnit } from "./scope";
import { MIN_REBUILD_RUNTIME_GENERATION } from "../sandbox/runtime-manifest";

// Runtime generations are one sequence shared by every image-build provider.
// The minimum compatible generation carries the generic provider-account token
// broker plugin; older managed-provider plugins call legacy routes.
export const MIN_REBUILD_RUNTIME_VERSION = MIN_REBUILD_RUNTIME_GENERATION;

export type ImageBuildRebuildDecision =
  | { type: "skip"; reason: "building" }
  | {
      type: "rebuild";
      reason: "missing_image" | "runtime_incompatible" | "invalid_provenance";
    }
  | { type: "check_branches"; recordedShas: Map<string, string> };

export function evaluateImageBuildRebuildPolicy(
  unit: EnabledScopeUnit,
  rows: ImageBuildRecordView[],
  provider: ImageBuildProvider
): ImageBuildRebuildDecision {
  const providerRows = rows.filter((row) => row.provider === provider);
  if (providerRows.some((row) => row.status === "building")) {
    return { type: "skip", reason: "building" };
  }

  const ready = providerRows.find(
    (row) => row.status === "ready" && row.repositoriesFingerprint === unit.repositoriesFingerprint
  );
  if (!ready) return { type: "rebuild", reason: "missing_image" };

  const runtimeVersion = parseRuntimeVersionNumber(ready.runtimeVersion);
  // Rebuild old images to the current toolchain without invalidating images
  // that remain safe to boot during the rollout gap.
  if (runtimeVersion === null || runtimeVersion < MIN_REBUILD_RUNTIME_VERSION) {
    return { type: "rebuild", reason: "runtime_incompatible" };
  }

  const provenance = ready.repositoryShas;
  if (!provenance) {
    return { type: "rebuild", reason: "invalid_provenance" };
  }

  const recordedShas = new Map<string, string>();
  for (const entry of provenance) {
    recordedShas.set(repositoryIdentityKey(entry), entry.baseSha);
  }
  if (
    unit.repositories.some((repository) => !recordedShas.has(repositoryIdentityKey(repository)))
  ) {
    return { type: "rebuild", reason: "invalid_provenance" };
  }
  return { type: "check_branches", recordedShas };
}
