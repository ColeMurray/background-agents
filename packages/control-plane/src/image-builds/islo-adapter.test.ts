import { describe, expect, it, vi } from "vitest";
import type { IsloSandboxProvider } from "../sandbox/providers/islo-provider";
import { IsloImageBuildAdapter } from "./islo-adapter";
import type { IsloImageBuildPlan } from "./types";

function createProvider(): IsloSandboxProvider {
  return {
    triggerRepoImageBuild: vi.fn(async () => ({ buildId: "build-1", status: "building" })),
    takeSnapshot: vi.fn(async () => ({ success: true, imageId: "islo-snapshot-1" })),
    deleteProviderImage: vi.fn(async () => undefined),
    deleteSandbox: vi.fn(async () => undefined),
  } as unknown as IsloSandboxProvider;
}

function createPlan(): IsloImageBuildPlan {
  return {
    provider: "islo",
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

describe("IsloImageBuildAdapter", () => {
  it("starts builds through the Islo provider capability", async () => {
    const provider = createProvider();
    const adapter = new IsloImageBuildAdapter(provider);
    const bindProviderSession = vi.fn();

    await adapter.startBuild(createPlan(), { bindProviderSession });

    expect(provider.triggerRepoImageBuild).toHaveBeenCalledWith({
      buildId: "build-1",
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "develop",
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

  it("snapshots completed build sandboxes", async () => {
    const provider = createProvider();
    const adapter = new IsloImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    const result = await adapter.finalizeSuccessfulBuild({
      buildId: "build-1",
      providerSessionId: "islo-session-1",
      correlation,
    });

    expect(result).toEqual({
      providerImageId: "islo-snapshot-1",
      providerSessionId: "islo-session-1",
    });
    expect(provider.takeSnapshot).toHaveBeenCalledWith({
      providerObjectId: "islo-session-1",
      sessionId: "build-1",
      reason: "image_build",
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
        sandbox_id: "islo-session-1",
      },
    });
  });

  it("deletes completed build sandboxes and provider images", async () => {
    const provider = createProvider();
    const adapter = new IsloImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    await adapter.cleanupCompletedBuild({
      buildId: "build-1",
      providerSessionId: "islo-session-1",
      correlation,
    });
    await adapter.deleteImage({
      image: { providerImageId: "islo-snapshot-1", providerSessionId: "islo-session-1" },
      correlation,
    });

    expect(provider.deleteSandbox).toHaveBeenCalledWith("islo-session-1");
    expect(provider.deleteProviderImage).toHaveBeenCalledWith("islo-snapshot-1");
  });
});
