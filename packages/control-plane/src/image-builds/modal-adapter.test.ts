import { describe, expect, it, vi } from "vitest";
import type { ModalImageBuildProvider } from "../sandbox/providers/modal-provider";
import { ModalImageBuildAdapter } from "./modal-adapter";
import type { ModalImageBuildPlan } from "./types";

function createProvider(): ModalImageBuildProvider {
  return {
    triggerImageBuild: vi.fn(async () => ({ buildId: "build-1", status: "building" })),
    deleteProviderImage: vi.fn(async () => undefined),
  };
}

function createPlan(): ModalImageBuildPlan {
  return {
    provider: "modal",
    callbackMode: "provider_image",
    buildId: "build-1",
    scope: { kind: "repo", id: "acme/repo" },
    repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
    repositoriesFingerprint: "fp-1",
    callbackUrl: "https://worker.test/image-builds/build-complete",
    failureCallbackUrl: "https://worker.test/image-builds/build-failed",
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

    await adapter.startBuild(plan, { bindProviderSession: vi.fn() });

    expect(provider.triggerImageBuild).toHaveBeenCalledWith({
      scopeKind: "repo",
      scopeId: "acme/repo",
      buildId: "build-1",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "develop" }],
      callbackUrl: "https://worker.test/image-builds/build-complete",
      failureCallbackUrl: "https://worker.test/image-builds/build-failed",
      buildTimeoutMs: 1_800_000,
      userEnvVars: { FOO: "bar" },
      correlation: {
        request_id: "request-1",
        trace_id: "trace-1",
      },
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
