import { describe, expect, it, vi } from "vitest";
import type { OpenComputerSandboxProvider } from "../sandbox/providers/opencomputer-provider";
import { OpenComputerImageBuildAdapter } from "./opencomputer-adapter";
import type { OpenComputerImageBuildPlan } from "./types";

function createProvider(): OpenComputerSandboxProvider {
  return {
    triggerEnvironmentImageBuild: vi.fn(async () => undefined),
    takeSnapshot: vi.fn(async () => ({ success: true, imageId: "oc-checkpoint-1" })),
    deleteSandbox: vi.fn(async () => ({ success: true })),
    deleteProviderImage: vi.fn(async () => undefined),
  } as unknown as OpenComputerSandboxProvider;
}

function createPlan(): OpenComputerImageBuildPlan {
  return {
    provider: "opencomputer",
    callbackMode: "provider_session",
    buildId: "build-1",
    scope: { kind: "repo", id: "acme/repo" },
    repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
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

describe("OpenComputerImageBuildAdapter", () => {
  it("starts builds through the OpenComputer provider capability", async () => {
    const provider = createProvider();
    const adapter = new OpenComputerImageBuildAdapter(provider);
    const bindProviderSession = vi.fn();

    await adapter.startBuild(createPlan(), { bindProviderSession });

    expect(provider.triggerEnvironmentImageBuild).toHaveBeenCalledWith({
      environmentId: "acme/repo",
      buildId: "build-1",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      callbackToken: "callback-token",
      cloneToken: "clone-token",
      buildTimeoutSeconds: 1801,
      userEnvVars: { FOO: "bar" },
      onProviderSessionCreated: bindProviderSession,
    });
  });

  it("checkpoints completed build sandboxes", async () => {
    const provider = createProvider();
    const adapter = new OpenComputerImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    const result = await adapter.finalizeSuccessfulBuild({
      buildId: "build-1",
      providerSessionId: "oc-session-1",
      correlation,
    });

    expect(result).toEqual({
      providerImageId: "oc-checkpoint-1",
      providerSessionId: "oc-session-1",
    });
    expect(provider.takeSnapshot).toHaveBeenCalledWith({
      providerObjectId: "oc-session-1",
      sessionId: "build-1",
      reason: "environment_image_build",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "oc-session-1",
      },
    });
  });

  it("keeps the secret store when tearing down a build whose image is ready", async () => {
    const provider = createProvider();
    const adapter = new OpenComputerImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    await adapter.cleanupCompletedBuild?.({
      buildId: "build-1",
      providerSessionId: "oc-session-1",
      correlation,
      keepSecretStore: true,
    });

    // The checkpoint retains the store as its base layer, so the store must
    // survive the build sandbox and be reaped later with the image.
    expect(provider.deleteSandbox).toHaveBeenCalledWith("oc-session-1", {
      deleteSecretStore: false,
    });
  });

  it("deletes the secret store when the completed build's checkpoint was discarded", async () => {
    const provider = createProvider();
    const adapter = new OpenComputerImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    await adapter.cleanupCompletedBuild?.({
      buildId: "build-1",
      providerSessionId: "oc-session-1",
      correlation,
      keepSecretStore: false,
    });

    expect(provider.deleteSandbox).toHaveBeenCalledWith("oc-session-1", {
      deleteSecretStore: true,
    });
  });

  it("deletes the secret store with the sandbox when a build fails", async () => {
    const provider = createProvider();
    const adapter = new OpenComputerImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    await adapter.cleanupFailedBuild?.({
      buildId: "build-1",
      providerSessionId: "oc-session-1",
      errorMessage: "boom",
      correlation,
    });

    expect(provider.deleteSandbox).toHaveBeenCalledWith("oc-session-1", {
      deleteSecretStore: true,
    });
  });

  it("reaps the checkpoint and its base secret store when deleting an image", async () => {
    const provider = createProvider();
    const adapter = new OpenComputerImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    await adapter.deleteImage({
      image: {
        providerImageId: "oc-checkpoint-1",
        providerSessionId: "oc-session-1",
        providerSecretStoreId: "secret-store-9",
      },
      correlation,
    });

    expect(provider.deleteProviderImage).toHaveBeenCalledWith(
      "oc-checkpoint-1",
      "oc-session-1",
      "secret-store-9"
    );
  });
});
