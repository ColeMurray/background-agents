import { describe, expect, it, vi } from "vitest";
import type { ModalRepoImageBuildProvider } from "../sandbox/providers/modal-provider";
import { ModalRepoImageBuildAdapter } from "./modal-adapter";
import type { ModalRepoImageBuildPlan } from "./types";

function createProvider(): ModalRepoImageBuildProvider {
  return {
    triggerRepoImageBuild: vi.fn(async () => ({ buildId: "build-1", status: "building" })),
    deleteProviderImage: vi.fn(async () => undefined),
  };
}

function createPlan(): ModalRepoImageBuildPlan {
  return {
    provider: "modal",
    callbackMode: "provider_image",
    buildId: "build-1",
    repoOwner: "acme",
    repoName: "repo",
    baseBranch: "develop",
    callbackUrl: "https://worker.test/repo-images/build-complete",
    buildTimeoutMs: 1_800_000,
    userEnvVars: { FOO: "bar" },
    correlation: {
      request_id: "request-1",
      trace_id: "trace-1",
    },
  };
}

describe("ModalRepoImageBuildAdapter", () => {
  it("starts builds through the Modal provider capability", async () => {
    const provider = createProvider();
    const adapter = new ModalRepoImageBuildAdapter(provider);
    const plan = createPlan();

    await adapter.startBuild(plan, { bindProviderSession: vi.fn() });

    expect(provider.triggerRepoImageBuild).toHaveBeenCalledWith({
      buildId: "build-1",
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "develop",
      callbackUrl: "https://worker.test/repo-images/build-complete",
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
    const adapter = new ModalRepoImageBuildAdapter(provider);
    const correlation = { request_id: "request-1", trace_id: "trace-1" };

    await adapter.deleteImage({
      providerImageId: "modal-image-1",
      correlation,
    });

    expect(provider.deleteProviderImage).toHaveBeenCalledWith("modal-image-1", correlation);
  });
});
