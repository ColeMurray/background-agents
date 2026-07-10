import { describe, expect, it, vi } from "vitest";
import type { VercelSandboxProvider } from "../sandbox/providers/vercel/provider";
import { VercelImageBuildAdapter } from "./vercel-adapter";
import type { VercelImageBuildPlan } from "./types";

function createProvider(): VercelSandboxProvider {
  return {
    triggerEnvironmentImageBuild: vi.fn(async () => undefined),
    takeSnapshot: vi.fn(async () => ({ success: true, imageId: "vercel-snapshot-1" })),
    stopSandbox: vi.fn(async () => ({ success: true })),
    deleteProviderImage: vi.fn(async () => undefined),
  } as unknown as VercelSandboxProvider;
}

function createPlan(): VercelImageBuildPlan {
  return {
    provider: "vercel",
    callbackMode: "provider_session",
    buildId: "build-1",
    scope: { kind: "repo", id: "acme/repo" },
    repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
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

describe("VercelImageBuildAdapter", () => {
  it("starts builds through the Vercel provider capability", async () => {
    const provider = createProvider();
    const adapter = new VercelImageBuildAdapter(provider);
    const bindProviderSession = vi.fn();

    await adapter.startBuild(createPlan(), { bindProviderSession });

    expect(provider.triggerEnvironmentImageBuild).toHaveBeenCalledWith({
      environmentId: "acme/repo",
      buildId: "build-1",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
      callbackUrl: "https://worker.test/image-builds/build-complete",
      callbackToken: "callback-token",
      cloneToken: "clone-token",
      buildTimeoutSeconds: 1801,
      userEnvVars: { FOO: "bar" },
      onProviderSessionCreated: bindProviderSession,
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
      },
    });
  });

  it("snapshots and stops completed build sandboxes", async () => {
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
