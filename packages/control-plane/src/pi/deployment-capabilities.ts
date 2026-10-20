import {
  createPiFeatureCapabilitySnapshot,
  resolvePiFeatureCapabilities,
  type PiFeatureCapabilitySnapshot,
} from "@open-inspect/shared/pi-feature-capabilities";
import type { EnvConfig } from "../types";
import {
  resolveSandboxExecutionCapability,
  type SandboxExecutionCapability,
} from "../sandbox/execution-capability";

type PiDeploymentCapabilityConfig = Pick<
  EnvConfig,
  | "PI_SCRATCH_WORKSPACE_MODE"
  | "PI_WORKSPACE_MODE"
  | "PI_REPOSITORY_EDITING_MODE"
  | "PI_CODE_MODE"
  | "PI_SANDBOX_EXECUTION_MODE"
  | "PI_EXTERNAL_ACTIONS_MODE"
  | "PI_MCP_MODE"
  | "PI_CROSS_SESSION_MESSAGING_MODE"
  | "PI_BROWSER_MODE"
>;

/** Resolve current deployment policy through the canonical shared normalizer. */
function resolvePiDeploymentCapabilities(config: PiDeploymentCapabilityConfig) {
  return resolvePiFeatureCapabilities({
    // The scratch VFS was renamed. The old variable still works until it is
    // removed, so a deployment does not silently lose the capability.
    scratchWorkspace: config.PI_SCRATCH_WORKSPACE_MODE ?? config.PI_WORKSPACE_MODE,
    repositoryEditing: config.PI_REPOSITORY_EDITING_MODE,
    codeMode: config.PI_CODE_MODE,
    sandboxExecution: config.PI_SANDBOX_EXECUTION_MODE,
    externalActions: config.PI_EXTERNAL_ACTIONS_MODE,
    mcp: config.PI_MCP_MODE,
    crossSessionMessaging: config.PI_CROSS_SESSION_MESSAGING_MODE,
    browser: config.PI_BROWSER_MODE,
  });
}

export function currentSandboxExecutionCapability(
  config: PiDeploymentCapabilityConfig &
    Pick<EnvConfig, "SANDBOX_PROVIDER" | "PI_SANDBOX_EXECUTION_ATTESTATION">,
  providerIsolation?: "enforced" | "canary_blocked"
): SandboxExecutionCapability {
  return resolveSandboxExecutionCapability({
    mode: config.PI_SANDBOX_EXECUTION_MODE,
    provider: config.SANDBOX_PROVIDER,
    attestation: config.PI_SANDBOX_EXECUTION_ATTESTATION,
    providerIsolation,
  });
}

export function createPiDeploymentCapabilitySnapshot(
  config: PiDeploymentCapabilityConfig &
    Partial<Pick<EnvConfig, "SANDBOX_PROVIDER" | "PI_SANDBOX_EXECUTION_ATTESTATION">>,
  providerIsolation?: "enforced" | "canary_blocked"
): PiFeatureCapabilitySnapshot {
  const capabilities = resolvePiDeploymentCapabilities(config);
  const execution = currentSandboxExecutionCapability(config, providerIsolation);
  return createPiFeatureCapabilitySnapshot({
    ...capabilities,
    sandboxExecution: execution.available ? capabilities.sandboxExecution : "off",
  });
}
