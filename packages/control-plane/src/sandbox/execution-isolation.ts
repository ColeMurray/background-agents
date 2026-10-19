import type { CreateSandboxConfig, SandboxProviderCapabilities } from "./provider";
import executionArtifact from "../../../sandbox-runtime/src/sandbox_runtime/execution_artifact_manifest.json";

export const EXECUTION_ARTIFACT_GENERATION = executionArtifact.runtimeGeneration;
export const EXECUTION_CREDENTIAL_MAX_LIFETIME_MS = 2 * 60 * 60 * 1_000;
export const EXECUTION_NETWORK_PROFILE = "package-install-v1" as const;
export const EXECUTION_PACKAGE_DOMAINS =
  executionArtifact.networkProfiles[EXECUTION_NETWORK_PROFILE];

export function assertExecutionIsolationSupported(
  runtimeMode: CreateSandboxConfig["runtimeMode"],
  providerName: string,
  capabilities: SandboxProviderCapabilities
): void {
  if (runtimeMode !== "execution") return;
  if (capabilities.executionIsolation !== "enforced") {
    throw new Error(`${providerName} execution isolation is canary-blocked`);
  }
  if (!capabilities.supportsSandboxTimeout) {
    throw new Error(`${providerName} cannot enforce execution credential lifetime`);
  }
}

/**
 * Reduce an execution launch to its credential-free, clean-image contract.
 * Existing agent launches are returned by identity and retain their behavior.
 */
export function secureExecutionSandboxConfig(
  config: CreateSandboxConfig,
  providerName: string,
  capabilities: SandboxProviderCapabilities
): CreateSandboxConfig {
  if (config.runtimeMode !== "execution") return config;
  assertExecutionIsolationSupported(config.runtimeMode, providerName, capabilities);
  const controlPlane = new URL(config.controlPlaneUrl);
  if (!controlPlane.hostname) throw new Error("Execution control plane hostname is required");
  const { cpuCores } = config.sandboxSettings ?? {};
  return {
    ...config,
    repoOwner: null,
    repoName: null,
    harness: undefined,
    provider: "",
    model: "",
    timeoutSeconds: Math.min(
      config.timeoutSeconds ?? EXECUTION_CREDENTIAL_MAX_LIFETIME_MS / 1_000,
      EXECUTION_CREDENTIAL_MAX_LIFETIME_MS / 1_000
    ),
    userEnvVars: undefined,
    prebuiltImageId: null,
    prebuiltImageSha: null,
    branch: null,
    codeServerEnabled: false,
    vncEnabled: false,
    agentSlackNotifyEnabled: false,
    mcpServers: undefined,
    repositories: undefined,
    sandboxSettings: cpuCores === undefined ? undefined : { cpuCores },
    execution: {
      artifactGeneration: EXECUTION_ARTIFACT_GENERATION,
      networkProfile: EXECUTION_NETWORK_PROFILE,
      allowedDomains: [controlPlane.hostname, ...EXECUTION_PACKAGE_DOMAINS],
    },
  };
}
