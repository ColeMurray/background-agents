import {
  createPiFeatureCapabilitySnapshot,
  resolvePiFeatureCapabilities,
  type PiFeatureCapabilitySnapshot,
} from "@open-inspect/shared/pi-feature-capabilities";
import type { EnvConfig } from "../types";

type PiDeploymentCapabilityConfig = Pick<
  EnvConfig,
  | "PI_WORKSPACE_MODE"
  | "PI_REPOSITORY_EDITING_MODE"
  | "PI_CODE_MODE"
  | "PI_SANDBOX_EXECUTION_MODE"
  | "PI_EXTERNAL_ACTIONS_MODE"
  | "PI_MCP_MODE"
>;

/** Resolve current deployment policy through the canonical shared normalizer. */
function resolvePiDeploymentCapabilities(config: PiDeploymentCapabilityConfig) {
  return resolvePiFeatureCapabilities({
    workspace: config.PI_WORKSPACE_MODE,
    repositoryEditing: config.PI_REPOSITORY_EDITING_MODE,
    codeMode: config.PI_CODE_MODE,
    sandboxExecution: config.PI_SANDBOX_EXECUTION_MODE,
    externalActions: config.PI_EXTERNAL_ACTIONS_MODE,
    mcp: config.PI_MCP_MODE,
  });
}

export function createPiDeploymentCapabilitySnapshot(
  config: PiDeploymentCapabilityConfig
): PiFeatureCapabilitySnapshot {
  return createPiFeatureCapabilitySnapshot(resolvePiDeploymentCapabilities(config));
}
