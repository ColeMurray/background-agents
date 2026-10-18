import {
  resolvePiFeatureCapabilities,
  type FeatureCapabilityMode,
} from "@open-inspect/shared/pi-feature-capabilities";

export type ComputerWorkspaceMode = FeatureCapabilityMode;

/** Map the deployment-facing writable alias onto the canonical capability vocabulary. */
export function resolveComputerWorkspaceMode(value: string | undefined): ComputerWorkspaceMode {
  const normalized = value?.trim().toLowerCase();
  return resolvePiFeatureCapabilities({
    workspace: normalized === "writable" ? "enabled" : normalized,
  }).workspace;
}
