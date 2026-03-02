import { afterEach, describe, expect, it, vi } from "vitest";
import { HelmApiClient, type HelmDeployRequest } from "./helm-provider";

vi.mock("@open-inspect/shared", () => ({
  generateInternalToken: vi.fn(async () => "test-token"),
}));

const deployRequest: HelmDeployRequest = {
  releaseName: "sandbox-123",
  sandboxId: "sandbox-123",
  sessionId: "session-123",
  repoOwner: "owner",
  repoName: "repo",
  controlPlaneUrl: "https://control-plane.example.com",
  sandboxAuthToken: "auth-token",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
  timeoutSeconds: 300,
  tunnelToken: "tunnel-token",
  namespace: "open-inspect",
};

describe("HelmApiClient URL normalization", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("adds http:// when apiUrl has no scheme", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          releaseName: "sandbox-123",
          sandboxId: "sandbox-123",
          status: "running",
          createdAt: Date.now(),
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HelmApiClient({
      apiUrl: "helm-deployer.open-inspect-system.svc.cluster.local.",
      apiSecret: "secret",
      namespace: "open-inspect",
      tunnelToken: "token",
    });

    await client.deploy(deployRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      "http://helm-deployer.open-inspect-system.svc.cluster.local./deploy",
      expect.any(Object)
    );
  });

  it("removes trailing slash from configured apiUrl", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          success: true,
          releaseName: "sandbox-123",
          sandboxId: "sandbox-123",
          status: "running",
          createdAt: Date.now(),
        }),
        { status: 200 }
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HelmApiClient({
      apiUrl: "https://helm-deployer.internal/",
      apiSecret: "secret",
      namespace: "open-inspect",
      tunnelToken: "token",
    });

    await client.deploy(deployRequest);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://helm-deployer.internal/deploy",
      expect.any(Object)
    );
  });
});
