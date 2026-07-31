import type { ImageBuildRecordView } from "@open-inspect/shared";
import {
  MIN_COMPATIBLE_RUNTIME_VERSION,
  parseRuntimeVersionNumber,
  type ImageBuildProvider,
} from "./model";
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

  let parsed: unknown;
  try {
    parsed = JSON.parse(ready.repository_shas);
  } catch {
    return { type: "rebuild", reason: "invalid_provenance" };
  }
  if (!Array.isArray(parsed)) {
    return { type: "rebuild", reason: "invalid_provenance" };
  }

  const recordedShas = new Map<string, string>();
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as { repoOwner?: unknown }).repoOwner !== "string" ||
      typeof (entry as { repoName?: unknown }).repoName !== "string" ||
      typeof (entry as { baseSha?: unknown }).baseSha !== "string"
    ) {
      return { type: "rebuild", reason: "invalid_provenance" };
    }
    const typed = entry as { repoOwner: string; repoName: string; baseSha: string };
    recordedShas.set(
      `${typed.repoOwner.toLowerCase()}/${typed.repoName.toLowerCase()}`,
      typed.baseSha
    );
  }
  if (
    unit.repositories.some(
      (repository) =>
        !recordedShas.has(
          `${repository.repoOwner.toLowerCase()}/${repository.repoName.toLowerCase()}`
        )
    )
  ) {
    return { type: "rebuild", reason: "invalid_provenance" };
  }
  return { type: "check_branches", recordedShas };
}
