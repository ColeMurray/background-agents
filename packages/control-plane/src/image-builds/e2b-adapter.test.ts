import { describe, expect, it, vi } from "vitest";
import type { E2BSandboxProvider } from "../sandbox/providers/e2b-provider";
import { E2BImageBuildAdapter } from "./e2b-adapter";
import { resolveImageBuildProviderSessionTimeoutSeconds } from "./timeouts";
import type { ImageBuildPlan } from "./types";

function createProvider(): E2BSandboxProvider {
  return {
    triggerImageBuild: vi.fn(async () => undefined),
    takePrebuiltImageSnapshot: vi.fn(async () => ({
      success: true,
      imageId: "snap-abc:default",
    })),
    deleteSandbox: vi.fn(async () => undefined),
    deleteProviderImage: vi.fn(async () => undefined),
  } as unknown as E2BSandboxProvider;
}

function createPlan(): ImageBuildPlan {
  return {
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
    correlation: { request_id: "request-1", trace_id: "trace-1" },
  };
}

describe("E2BImageBuildAdapter", () => {
  it("starts builds through the E2B provider capability", async () => {
    const provider = createProvider();
    const adapter = new E2BImageBuildAdapter(provider);
    const bindProviderSession = vi.fn();

    await adapter.startBuild(createPlan(), { bindProviderSession });

    expect(provider.triggerImageBuild).toHaveBeenCalledWith({
      scopeKind: "repo",
      scopeId: "acme/repo",
      buildId: "build-1",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      callbackToken: "callback-token",
      cloneToken: "clone-token",
      buildExecutionTimeoutSeconds: 1801,
      providerSessionTimeoutSeconds: resolveImageBuildProviderSessionTimeoutSeconds(1_800_001),
      userEnvVars: { FOO: "bar" },
      onProviderSessionCreated: bindProviderSession,
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
  });

  it("snapshots the completed build sandbox", async () => {
    const provider = createProvider();
    const adapter = new E2BImageBuildAdapter(provider);

    const result = await adapter.finalizeSuccessfulBuild({
      buildId: "build-1",
      providerSessionId: "e2b-session-1",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });

    expect(result).toEqual({
      providerImageId: "snap-abc:default",
      providerSessionId: "e2b-session-1",
    });
    expect(provider.takePrebuiltImageSnapshot).toHaveBeenCalledWith({
      providerObjectId: "e2b-session-1",
      sessionId: "build-1",
      reason: "environment_image_build",
      correlation: { request_id: "request-1", trace_id: "trace-1", sandbox_id: "e2b-session-1" },
    });
  });

  it("fails the build when the snapshot returns no image id", async () => {
    const provider = createProvider();
    vi.mocked(provider.takePrebuiltImageSnapshot).mockResolvedValueOnce({
      success: false,
      error: "boom",
    });
    const adapter = new E2BImageBuildAdapter(provider);

    await expect(
      adapter.finalizeSuccessfulBuild({
        buildId: "build-1",
        providerSessionId: "e2b-session-1",
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      })
    ).rejects.toThrow(/boom/);
  });

  it("kills the build sandbox after a completed build", async () => {
    const provider = createProvider();
    const adapter = new E2BImageBuildAdapter(provider);

    await adapter.cleanupCompletedBuild({
      buildId: "build-1",
      providerSessionId: "e2b-session-1",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });

    expect(provider.deleteSandbox).toHaveBeenCalledWith("e2b-session-1");
  });

  it("kills the build sandbox on failed builds", async () => {
    const provider = createProvider();
    const adapter = new E2BImageBuildAdapter(provider);

    await adapter.cleanupFailedBuild({
      buildId: "build-1",
      providerSessionId: "e2b-session-1",
      errorMessage: "setup.sh failed",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });

    expect(provider.deleteSandbox).toHaveBeenCalledWith("e2b-session-1");
  });

  it("deletes provider images through the E2B provider capability", async () => {
    const provider = createProvider();
    const adapter = new E2BImageBuildAdapter(provider);

    await adapter.deleteImage({
      image: { providerImageId: "snap-abc:default", providerSessionId: "ignored-session" },
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });

    expect(provider.deleteProviderImage).toHaveBeenCalledWith("snap-abc:default");
  });
});
