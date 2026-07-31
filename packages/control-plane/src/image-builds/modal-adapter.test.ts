import { describe, expect, it, vi } from "vitest";
import type { ModalImageBuildProvider } from "../sandbox/providers/modal-provider";
import { ModalImageBuildAdapter } from "./modal-adapter";
import type { ModalImageBuildPlan } from "./types";

function createProvider(): ModalImageBuildProvider {
  return {
    triggerImageBuild: vi.fn(async () => ({ buildId: "build-1", status: "building" })),
    triggerEnvironmentImageBuild: vi.fn(async () => ({
      buildId: "build-1",
      status: "building",
    })),
    terminateImageBuildSandbox: vi.fn(async () => undefined),
    snapshotImageBuildSandbox: vi.fn(async () => ({ success: true, imageId: "modal-image-1" })),
    deleteProviderImage: vi.fn(async () => undefined),
  };
}

function createPlan(): ModalImageBuildPlan {
  return {
    provider: "modal",
    callbackMode: "provider_session",
    buildId: "build-1",
    scope: { kind: "repo", id: "acme/repo" },
    repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    callbackToken: "modal-callback-token",
    cloneAuth: {
      type: "credential_helper",
      host: "github.com",
      username: "x-access-token",
      token: "clone-token",
    },
    buildTimeoutMs: 1_800_000,
    userEnvVars: { FOO: "bar" },
    correlation: {
      request_id: "request-1",
      trace_id: "trace-1",
    },
  };
}

describe("ModalImageBuildAdapter", () => {
  it("starts builds through the Modal provider capability", async () => {
    const provider = createProvider();
    const adapter = new ModalImageBuildAdapter(provider);
    const plan = createPlan();

    const bindProviderSession = vi.fn(async () => undefined);
    await adapter.startBuild(plan, { bindProviderSession });

    expect(provider.triggerEnvironmentImageBuild).toHaveBeenCalledWith({
      scopeKind: "repo",
      scopeId: "acme/repo",
      buildId: "build-1",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      callbackToken: "modal-callback-token",
      cloneToken: "clone-token",
      cloneHost: "github.com",
      cloneUsername: "x-access-token",
      buildTimeoutMs: 1_800_000,
      userEnvVars: { FOO: "bar" },
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
      },
      onProviderSessionCreated: bindProviderSession,
    });
  });

  it("snapshots the bound Modal build sandbox on completion", async () => {
    const provider = createProvider();
    const adapter = new ModalImageBuildAdapter(provider);

    await expect(
      adapter.finalizeSuccessfulBuild({
        buildId: "build-1",
        providerSessionId: "modal-session-1",
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      })
    ).resolves.toEqual({
      providerImageId: "modal-image-1",
      providerSessionId: "modal-session-1",
    });
  });

  it("terminates failed Modal build sandboxes", async () => {
    const provider = createProvider();
    const adapter = new ModalImageBuildAdapter(provider);

    await adapter.cleanupFailedBuild({
      buildId: "build-1",
      providerSessionId: "modal-session-1",
      errorMessage: "setup failed",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });

    expect(provider.terminateImageBuildSandbox).toHaveBeenCalledWith({
      buildId: "build-1",
      providerSessionId: "modal-session-1",
      reason: "image_build_failed",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });
  });

  it("deletes provider images through the Modal provider capability", async () => {
    const provider = createProvider();
    const adapter = new ModalImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    await adapter.deleteImage({
      image: { providerImageId: "modal-image-1" },
      correlation,
    });

    expect(provider.deleteProviderImage).toHaveBeenCalledWith("modal-image-1", correlation);
  });
});
