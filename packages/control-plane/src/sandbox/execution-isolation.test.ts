import { describe, expect, it } from "vitest";
import type { CreateSandboxConfig, SandboxProviderCapabilities } from "./provider";
import {
  EXECUTION_ARTIFACT_GENERATION,
  EXECUTION_NETWORK_PROFILE,
  secureExecutionSandboxConfig,
} from "./execution-isolation";

const baseConfig: CreateSandboxConfig = {
  runtimeMode: "execution",
  sessionId: "session-1",
  sandboxId: "sandbox-1",
  repoOwner: "secret-owner",
  repoName: "secret-repo",
  controlPlaneUrl: "https://control.example.com",
  sandboxAuthToken: "execution-token",
  harness: "opencode",
  provider: "openai",
  model: "openai/gpt-5",
  userEnvVars: { SECRET: "hidden" },
  prebuiltImageId: "repo-image",
  prebuiltImageSha: "deadbeef",
  branch: "secret-branch",
  codeServerEnabled: true,
  vncEnabled: true,
  agentSlackNotifyEnabled: true,
  mcpServers: [{ id: "secret", name: "secret", type: "local", command: ["secret"], enabled: true }],
  sandboxSettings: { terminalEnabled: true, tunnelPorts: [3000], cpuCores: 2 },
  repositories: [{ repoOwner: "secret-owner", repoName: "secret-repo", baseBranch: "main" }],
};

function capabilities(
  executionIsolation: "enforced" | "canary_blocked"
): SandboxProviderCapabilities {
  return {
    supportsSandboxTimeout: true,
    supportsSnapshots: true,
    supportsRestore: true,
    executionIsolation,
  };
}

describe("secureExecutionSandboxConfig", () => {
  it("reduces execution launch input to the clean artifact and package registry profile", () => {
    expect(
      secureExecutionSandboxConfig(baseConfig, "test-provider", capabilities("enforced"))
    ).toEqual({
      ...baseConfig,
      repoOwner: null,
      repoName: null,
      harness: undefined,
      provider: "",
      model: "",
      timeoutSeconds: 7200,
      userEnvVars: undefined,
      prebuiltImageId: null,
      prebuiltImageSha: null,
      branch: null,
      codeServerEnabled: false,
      vncEnabled: false,
      agentSlackNotifyEnabled: false,
      mcpServers: undefined,
      repositories: undefined,
      sandboxSettings: { cpuCores: 2 },
      execution: {
        artifactGeneration: EXECUTION_ARTIFACT_GENERATION,
        networkProfile: EXECUTION_NETWORK_PROFILE,
        allowedDomains: [
          "control.example.com",
          "registry.npmjs.org",
          "pypi.org",
          "files.pythonhosted.org",
        ],
      },
    });
  });

  it.each(["modal", "modal-vm", "opencomputer", "daytona", "vercel", "e2b"])(
    "keeps %s canary-blocked until its sandbox layer enforces isolation",
    (provider) => {
      expect(() =>
        secureExecutionSandboxConfig(baseConfig, provider, capabilities("canary_blocked"))
      ).toThrow(`${provider} execution isolation is canary-blocked`);
    }
  );

  it("does not alter existing agent sandboxes", () => {
    const agent = { ...baseConfig, runtimeMode: "agent" as const };
    expect(secureExecutionSandboxConfig(agent, "e2b", capabilities("canary_blocked"))).toBe(agent);
  });
});
