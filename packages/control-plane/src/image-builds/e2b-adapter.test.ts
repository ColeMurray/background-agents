import { describe, expect, it, vi } from "vitest";
import { E2BApiError } from "../sandbox/e2b-rest-client";
import { SandboxProviderError } from "../sandbox/provider";
import { ImageBuildFinalizationAttemptError } from "./finalization-error";
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
    cloneAuth: {
      type: "credential_helper",
      host: "github.com",
      username: "x-access-token",
      token: "clone-token",
    },
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
      signal: undefined,
    });
  });

  it("forwards the caller deadline into the snapshot and the teardown", async () => {
    const provider = createProvider();
    const adapter = new E2BImageBuildAdapter(provider);
    const signal = AbortSignal.timeout(60_000);
    const input = {
      buildId: "build-1",
      providerSessionId: "e2b-session-1",
      correlation: { request_id: "request-1", trace_id: "trace-1" },
      signal,
    };

    await adapter.finalizeSuccessfulBuild(input);
    await adapter.cleanupCompletedBuild(input);
    await adapter.deleteImage({
      image: { providerImageId: "snap-abc:default", providerSessionId: "e2b-session-1" },
      correlation: input.correlation,
      signal,
    });

    expect(provider.takePrebuiltImageSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ signal })
    );
    expect(provider.deleteSandbox).toHaveBeenCalledWith("e2b-session-1", signal);
    expect(provider.deleteProviderImage).toHaveBeenCalledWith("snap-abc:default", signal);
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

  it("turns a rate-limited bake into a retryable finalization attempt", async () => {
    const provider = createProvider();
    vi.mocked(provider.takePrebuiltImageSnapshot).mockRejectedValueOnce(
      new SandboxProviderError(
        "Failed to bake E2B image snapshot (rate-limited during snapshot)",
        "transient",
        new E2BApiError("slow down", 429)
      )
    );
    const adapter = new E2BImageBuildAdapter(provider);

    // A 429 rejects the request, so no template exists; the finalizer retries
    // definitely_not_created instead of failing the build and killing the sandbox.
    await expect(
      adapter.finalizeSuccessfulBuild({
        buildId: "build-1",
        providerSessionId: "e2b-session-1",
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      })
    ).rejects.toMatchObject({
      name: "ImageBuildFinalizationAttemptError",
      outcome: "definitely_not_created",
    });
  });

  it("leaves non-rate-limit provider failures terminal", async () => {
    const provider = createProvider();
    vi.mocked(provider.takePrebuiltImageSnapshot).mockRejectedValueOnce(
      new SandboxProviderError("boom", "permanent", new E2BApiError("gone", 500))
    );
    const adapter = new E2BImageBuildAdapter(provider);

    await expect(
      adapter.finalizeSuccessfulBuild({
        buildId: "build-1",
        providerSessionId: "e2b-session-1",
        correlation: { request_id: "request-1", trace_id: "trace-1" },
      })
    ).rejects.not.toBeInstanceOf(ImageBuildFinalizationAttemptError);
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
