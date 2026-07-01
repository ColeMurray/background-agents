import { describe, expect, it, vi } from "vitest";
import type { OpenComputerSandboxProvider } from "../sandbox/providers/opencomputer-provider";
import { OpenComputerRepoImageBuildAdapter } from "./opencomputer-adapter";
import type { OpenComputerRepoImageBuildPlan } from "./types";

function createProvider(): OpenComputerSandboxProvider {
  return {
    triggerRepoImageBuild: vi.fn(async () => ({ buildId: "build-1", status: "building" })),
    takeSnapshot: vi.fn(async () => ({ success: true, imageId: "oc-checkpoint-1" })),
    deleteSandbox: vi.fn(async () => ({ success: true })),
    deleteProviderImage: vi.fn(async () => undefined),
  } as unknown as OpenComputerSandboxProvider;
}

function createPlan(): OpenComputerRepoImageBuildPlan {
  return {
    provider: "opencomputer",
    callbackMode: "provider_session",
    buildId: "build-1",
    repoOwner: "acme",
    repoName: "repo",
    baseBranch: "develop",
    callbackUrl: "https://worker.test/repo-images/build-complete",
    callbackToken: "callback-token",
    cloneAuth: { type: "credential_helper", token: "clone-token" },
    buildTimeoutMs: 1_800_001,
    userEnvVars: { FOO: "bar" },
    correlation: {
      request_id: "request-1",
      trace_id: "trace-1",
    },
  };
}

describe("OpenComputerRepoImageBuildAdapter", () => {
  it("starts builds through the OpenComputer provider capability", async () => {
    const provider = createProvider();
    const adapter = new OpenComputerRepoImageBuildAdapter(provider);
    const bindProviderSession = vi.fn();

    await adapter.startBuild(createPlan(), { bindProviderSession });

    expect(provider.triggerRepoImageBuild).toHaveBeenCalledWith({
      buildId: "build-1",
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "develop",
      callbackUrl: "https://worker.test/repo-images/build-complete",
      callbackToken: "callback-token",
      cloneToken: "clone-token",
      buildTimeoutSeconds: 1801,
      userEnvVars: { FOO: "bar" },
      onProviderSessionCreated: bindProviderSession,
    });
  });

  it("snapshots completed build sandboxes", async () => {
    const provider = createProvider();
    const adapter = new OpenComputerRepoImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    const result = await adapter.finalizeSuccessfulBuild({
      kind: "provider_session",
      buildId: "build-1",
      providerSessionId: "oc-session-1",
      baseSha: "abc123",
      buildDurationMs: 42_000,
      correlation,
    });

    expect(result).toEqual({
      providerImageId: "oc-checkpoint-1",
      providerSessionId: "oc-session-1",
    });
    expect(provider.takeSnapshot).toHaveBeenCalledWith({
      providerObjectId: "oc-session-1",
      sessionId: "build-1",
      reason: "repo_image_build",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "oc-session-1",
      },
    });
  });

  it("cleans up completed build sandboxes and deletes checkpoints with session context", async () => {
    const provider = createProvider();
    const adapter = new OpenComputerRepoImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    await adapter.cleanupCompletedBuild?.({
      kind: "provider_session",
      buildId: "build-1",
      providerSessionId: "oc-session-1",
      correlation,
    });
    await adapter.deleteImage({
      image: { providerImageId: "oc-checkpoint-1", providerSessionId: "oc-session-1" },
      correlation,
    });

    expect(provider.deleteSandbox).toHaveBeenCalledWith("oc-session-1");
    expect(provider.deleteProviderImage).toHaveBeenCalledWith("oc-checkpoint-1", "oc-session-1");
  });
});
