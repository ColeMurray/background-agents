import {
  resolvePiFeatureCapabilities,
  type FeatureCapabilityMode,
} from "@open-inspect/shared/pi-feature-capabilities";

export type ComputerWorkspaceMode = FeatureCapabilityMode;

/** Backward-compatible wrapper around the canonical shared capability resolver. */
export function resolveComputerWorkspaceMode(value: string | undefined): ComputerWorkspaceMode {
  return resolvePiFeatureCapabilities({ workspace: value }).workspace;
}
