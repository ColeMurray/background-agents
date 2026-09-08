import { describe, expect, it, vi } from "vitest";
import type { ModalImageBuildProvider } from "../sandbox/providers/modal-provider";
import { ModalApiError } from "../sandbox/client";
import { SandboxProviderError } from "../sandbox/provider";
import { ModalImageBuildAdapter } from "./modal-adapter";
import type { ImageBuildPlan } from "./types";
import type { ImageBuildFinalizationAttemptError } from "./finalization-error";

function createProvider(): ModalImageBuildProvider {
  return {
    triggerImageBuild: vi.fn(async () => undefined),
    terminateImageBuildSandbox: vi.fn(async () => undefined),
    snapshotImageBuildSandbox: vi.fn(async () => ({ success: true, imageId: "modal-image-1" })),
    deleteProviderImage: vi.fn(async () => undefined),
  };
}

function createPlan(): ImageBuildPlan {
  return {
    buildId: "build-1",
    scope: { kind: "repo", id: "acme/repo" },
    repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
    callbackToken: "modal-callback-token",
    cloneAuth: {
      type: "credential_helper",
      host: "gitlab.com",
      username: "oauth2",
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
  it("delegates build startup to the Modal provider", async () => {
    const provider = createProvider();
    const adapter = new ModalImageBuildAdapter(provider);
    const plan = createPlan();
    const bindProviderSession = vi.fn(async () => undefined);

    await adapter.startBuild(plan, { bindProviderSession });

    expect(provider.triggerImageBuild).toHaveBeenCalledWith({
      scopeKind: "repo",
      scopeId: "acme/repo",
      buildId: "build-1",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
      cloneToken: "clone-token",
      cloneHost: "gitlab.com",
      cloneUsername: "oauth2",
      buildExecutionTimeoutSeconds: 1800,
      providerSessionTimeoutSeconds: 2400,
      userEnvVars: { FOO: "bar" },
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      callbackToken: "modal-callback-token",
      onProviderSessionCreated: bindProviderSession,
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
      },
    });
  });

  it("leaves post-bind start-failure cleanup to the workflow", async () => {
    const provider = createProvider();
    const bindProviderSession = vi.fn(async () => undefined);
    vi.mocked(provider.triggerImageBuild).mockImplementation(async (config) => {
      await config.onProviderSessionCreated("modal-session-1");
      throw new Error("launch failed");
    });

    await expect(
      new ModalImageBuildAdapter(provider).startBuild(createPlan(), { bindProviderSession })
    ).rejects.toThrow("launch failed");

    expect(bindProviderSession).toHaveBeenCalledWith("modal-session-1");
    expect(provider.terminateImageBuildSandbox).not.toHaveBeenCalled();
  });

  it("snapshots and terminates completed build sandboxes", async () => {
    const provider = createProvider();
    const adapter = new ModalImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    expect(
      await adapter.finalizeSuccessfulBuild?.({
        buildId: "build-1",
        providerSessionId: "modal-session-1",
        correlation,
      })
    ).toEqual({
      providerImageId: "modal-image-1",
      providerSessionId: "modal-session-1",
    });
    await adapter.cleanupCompletedBuild?.({
      buildId: "build-1",
      providerSessionId: "modal-session-1",
      correlation,
    });

    expect(provider.snapshotImageBuildSandbox).toHaveBeenCalledWith({
      buildId: "build-1",
      providerSessionId: "modal-session-1",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "modal-session-1",
      },
    });
    expect(provider.terminateImageBuildSandbox).toHaveBeenCalledWith({
      buildId: "build-1",
      providerSessionId: "modal-session-1",
      reason: "image_build_complete",
      correlation,
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

  it("marks an explicit pre-mutation rate-limit rejection as safe to retry", async () => {
    const provider = createProvider();
    vi.mocked(provider.snapshotImageBuildSandbox).mockRejectedValue(
      new SandboxProviderError(
        "snapshot rate limited",
        "permanent",
        new ModalApiError("rate limited", 429)
      )
    );

    await expect(
      new ModalImageBuildAdapter(provider).finalizeSuccessfulBuild({
        buildId: "build-1",
        providerSessionId: "modal-session-1",
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      })
    ).rejects.toMatchObject({
      outcome: "definitely_not_created",
    } satisfies Partial<ImageBuildFinalizationAttemptError>);
  });

  it("keeps an unclassified snapshot failure ambiguous", async () => {
    const provider = createProvider();
    vi.mocked(provider.snapshotImageBuildSandbox).mockResolvedValue({
      success: false,
      error: "snapshot failed after dispatch",
    });

    await expect(
      new ModalImageBuildAdapter(provider).finalizeSuccessfulBuild({
        buildId: "build-1",
        providerSessionId: "modal-session-1",
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      })
    ).rejects.toThrow("snapshot failed after dispatch");
  });
});
