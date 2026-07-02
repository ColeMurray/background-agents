import { describe, expect, it, vi } from "vitest";
import type { VercelSandboxProvider } from "../sandbox/providers/vercel/provider";
import { VercelRepoImageBuildAdapter } from "./vercel-adapter";
import type { VercelRepoImageBuildPlan } from "./types";

function createProvider(): VercelSandboxProvider {
  return {
    triggerRepoImageBuild: vi.fn(async () => ({ buildId: "build-1", status: "building" })),
    takeSnapshot: vi.fn(async () => ({ success: true, imageId: "vercel-snapshot-1" })),
    stopSandbox: vi.fn(async () => ({ success: true })),
    deleteProviderImage: vi.fn(async () => undefined),
  } as unknown as VercelSandboxProvider;
}

function createPlan(): VercelRepoImageBuildPlan {
  return {
    provider: "vercel",
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

describe("VercelRepoImageBuildAdapter", () => {
  it("starts builds through the Vercel provider capability", async () => {
    const provider = createProvider();
    const adapter = new VercelRepoImageBuildAdapter(provider);
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
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
      },
    });
  });

  it("snapshots and stops completed build sandboxes", async () => {
    const provider = createProvider();
    const adapter = new VercelRepoImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    const result = await adapter.finalizeSuccessfulBuild({
      kind: "provider_session",
      buildId: "build-1",
      providerSessionId: "vercel-session-1",
      baseSha: "abc123",
      buildDurationMs: 42_000,
      correlation,
    });

    expect(result).toEqual({
      providerImageId: "vercel-snapshot-1",
      providerSessionId: "vercel-session-1",
    });
    expect(provider.takeSnapshot).toHaveBeenCalledWith({
      providerObjectId: "vercel-session-1",
      sessionId: "build-1",
      reason: "repo_image_build",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "vercel-session-1",
      },
    });
    expect(provider.stopSandbox).toHaveBeenCalledWith({
      providerObjectId: "vercel-session-1",
      sessionId: "build-1",
      reason: "repo_image_build_complete",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "vercel-session-1",
      },
    });
  });

  it("deletes provider images through the Vercel provider capability", async () => {
    const provider = createProvider();
    const adapter = new VercelRepoImageBuildAdapter(provider);

    await adapter.deleteImage({
      image: { providerImageId: "vercel-snapshot-1", providerSessionId: "ignored-session" },
      correlation: { request_id: "request-1", trace_id: "trace-1" },
    });

    expect(provider.deleteProviderImage).toHaveBeenCalledWith("vercel-snapshot-1");
  });
});
