import { describe, expect, it, vi } from "vitest";
import type { VercelSandboxProvider } from "../sandbox/providers/vercel/provider";
import { VercelImageBuildAdapter } from "./vercel-adapter";
import type { ImageBuildPlan } from "./types";

function createProvider(): VercelSandboxProvider {
  return {
    triggerImageBuild: vi.fn(async () => undefined),
    takeSnapshot: vi.fn(async () => ({ success: true, imageId: "vercel-snapshot-1" })),
    stopSandbox: vi.fn(async () => ({ success: true })),
    deleteProviderImage: vi.fn(async () => undefined),
  } as unknown as VercelSandboxProvider;
}

function createPlan(buildTimeoutMs = 1_800_001): ImageBuildPlan {
  return {
    provider: "vercel",
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
    buildTimeoutMs,
    userEnvVars: { FOO: "bar" },
    correlation: {
      request_id: "request-1",
      trace_id: "trace-1",
    },
  };
}

describe("VercelImageBuildAdapter", () => {
  it("starts builds through the Vercel provider capability", async () => {
    const provider = createProvider();
    const adapter = new VercelImageBuildAdapter(provider);
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
      providerSessionTimeoutSeconds: 2401,
      userEnvVars: { FOO: "bar" },
      onProviderSessionCreated: bindProviderSession,
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
      },
    });
  });

  it.each([
    [1, 1, 11],
    [35, 35, 45],
    [45, 35, 45],
    [60, 35, 45],
  ])(
    "preserves ten minutes of finalization headroom for a %d-minute configured budget",
    async (configuredMinutes, expectedExecutionMinutes, expectedSessionMinutes) => {
      const provider = createProvider();
      const adapter = new VercelImageBuildAdapter(provider);

      await adapter.startBuild(createPlan(configuredMinutes * 60_000), {
        bindProviderSession: vi.fn(),
      });

      expect(provider.triggerImageBuild).toHaveBeenCalledWith(
        expect.objectContaining({
          buildExecutionTimeoutSeconds: expectedExecutionMinutes * 60,
          providerSessionTimeoutSeconds: expectedSessionMinutes * 60,
        })
      );
    }
  );

  it("snapshots and then explicitly cleans up completed build sandboxes", async () => {
    const provider = createProvider();
    const adapter = new VercelImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    const result = await adapter.finalizeSuccessfulBuild({
      buildId: "build-1",
      providerSessionId: "vercel-session-1",
      correlation,
    });

    expect(result).toEqual({
      providerImageId: "vercel-snapshot-1",
      providerSessionId: "vercel-session-1",
    });
    expect(provider.takeSnapshot).toHaveBeenCalledWith({
      providerObjectId: "vercel-session-1",
      sessionId: "build-1",
      reason: "environment_image_build",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "vercel-session-1",
      },
      signal: undefined,
    });
    expect(provider.stopSandbox).not.toHaveBeenCalled();

    await adapter.cleanupCompletedBuild?.({
      buildId: "build-1",
      providerSessionId: "vercel-session-1",
      correlation,
    });
    expect(provider.stopSandbox).toHaveBeenCalledWith({
      providerObjectId: "vercel-session-1",
      sessionId: "build-1",
      reason: "environment_image_build_complete",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "vercel-session-1",
      },
    });
  });

  it("deletes provider images through the Vercel provider capability", async () => {
    const provider = createProvider();
    const adapter = new VercelImageBuildAdapter(provider);

    await adapter.deleteImage({
      image: { providerImageId: "vercel-snapshot-1", providerSessionId: "ignored-session" },
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });

    expect(provider.deleteProviderImage).toHaveBeenCalledWith("vercel-snapshot-1");
  });
});
