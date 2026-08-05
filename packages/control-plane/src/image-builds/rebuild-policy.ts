import type { ImageBuildRecordView } from "@open-inspect/shared/types/image-builds";
import {
  MIN_COMPATIBLE_RUNTIME_VERSION,
  parseRuntimeVersionNumber,
  type ImageBuildProvider,
} from "./model";
import { parseRepositoryShasJson, repositoryIdentityKey } from "./provenance";
import type { EnabledScopeUnit } from "./scope";

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
    (row) => row.status === "ready" && row.repositories_fingerprint === unit.repositoriesFingerprint
  );
  if (!ready) return { type: "rebuild", reason: "missing_image" };

  const runtimeVersion = parseRuntimeVersionNumber(ready.runtime_version);
  if (runtimeVersion === null || runtimeVersion < MIN_COMPATIBLE_RUNTIME_VERSION) {
    return { type: "rebuild", reason: "runtime_incompatible" };
  }

  const provenance = parseRepositoryShasJson(ready.repository_shas);
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
