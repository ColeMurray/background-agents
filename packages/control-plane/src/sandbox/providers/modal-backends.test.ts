import { afterEach, describe, expect, it, vi } from "vitest";
import { createModalClient, type ModalClient } from "../client";
import { SandboxLaunchRejectedError } from "../provider";
import { ModalSandboxProvider } from "./modal-provider";
import { resolveSandboxDashboardUrl } from "../../session/sandbox-access";

const config = {
  sessionId: "session-1",
  sandboxId: "sandbox-1",
  repoOwner: null,
  repoName: null,
  controlPlaneUrl: "https://cp.test",
  sandboxAuthToken: "token",
  harness: "opencode" as const,
  provider: "anthropic",
  model: "model",
  retireSandboxId: "prior-generation",
};
const build = {
  buildId: "build-1",
  scopeKind: "repo" as const,
  scopeId: "acme/repo",
  repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "main" }],
  callbackUrl: "https://cp.test/complete",
  failureCallbackUrl: "https://cp.test/failed",
  callbackToken: "token",
  buildExecutionTimeoutSeconds: 60,
  providerSessionTimeoutSeconds: 120,
  correlation: { trace_id: "trace", request_id: "request" },
};

function fixture(confirmation: unknown) {
  const result = {
    sandboxId: "sandbox-1",
    modalObjectId: "sb-1",
    createdAt: 1,
    sandboxBackend: confirmation,
  };
  const client = {
    createSandbox: vi.fn().mockResolvedValue(result),
    restoreSandbox: vi.fn().mockResolvedValue(result),
    stopSandbox: vi.fn().mockResolvedValue(undefined),
    createImageBuildSandbox: vi
      .fn()
      .mockResolvedValue({ providerSessionId: "sb-1", sandboxBackend: confirmation }),
    startImageBuildSandbox: vi.fn().mockResolvedValue(undefined),
    snapshotSandbox: vi.fn().mockResolvedValue({ imageId: "im-1", sourceStopped: true }),
  };
  return {
    client,
    provider: new ModalSandboxProvider(client as unknown as ModalClient, "modal-vm"),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("distinct Modal backend identities", () => {
  it("uses a dedicated read-only receipt endpoint after the original capture deadline", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          success: true,
          data: { image_id: "im-recovered" },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const provider = new ModalSandboxProvider(createModalClient("secret", "acme"), "modal-vm");
    await expect(
      provider.recoverSnapshotReceipt({
        providerObjectId: 'modal-vm-session:["session","generation"]',
        sessionId: "session",
        deadlineAtMs: Date.now() + 30_000,
      })
    ).resolves.toEqual({ imageId: "im-recovered" });
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("api-recover-sandbox-snapshot");
    expect(JSON.parse(options.body)).toEqual({
      sandbox_id: 'modal-vm-session:["session","generation"]',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it("recovers a lost terminal snapshot response using the same source reference and deadline", async () => {
    const { client, provider } = fixture("modal-vm");
    client.snapshotSandbox.mockRejectedValueOnce(new Error("response lost"));
    await expect(
      provider.takeSnapshot({
        providerObjectId: "sb-1",
        sessionId: "session-1",
        reason: "shutdown",
        deadlineAtMs: Date.now() + 60_000,
      })
    ).resolves.toMatchObject({ success: true, imageId: "im-1", sourceStopped: true });
    expect(client.snapshotSandbox).toHaveBeenCalledTimes(2);
    expect(client.snapshotSandbox.mock.calls[0]).toEqual(client.snapshotSandbox.mock.calls[1]);
  });
  it("selects the immutable backend on both launch paths without altering generic resources", async () => {
    const { provider, client } = fixture("modal-vm");
    const settings = { cpuCores: 3, memoryMib: null };
    await provider.createSandbox({ ...config, sandboxSettings: settings });
    await provider.restoreFromSnapshot({
      ...config,
      snapshotImageId: "im-1",
      sandboxSettings: settings,
    });
    for (const call of [client.createSandbox, client.restoreSandbox]) {
      expect(call).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxBackend: "modal-vm",
          retireSandboxId: "prior-generation",
          sandboxSettings: settings,
        }),
        undefined
      );
    }
    expect(provider.name).toBe("modal-vm");
    expect(provider.capabilities.snapshotStopsSandbox).toBe(true);
  });

  it.each([undefined, null, false, "modal", "future-backend", { unexpected: true }])(
    "returns rejected create/restore handles before cleanup with confirmation %j",
    async (value) => {
      const { provider, client } = fixture(value);
      await expect(provider.createSandbox(config)).rejects.toThrow("did not confirm");
      await expect(
        provider.restoreFromSnapshot({ ...config, snapshotImageId: "im-1" })
      ).rejects.toThrow("did not confirm");
      expect(client.stopSandbox).not.toHaveBeenCalled();
    }
  );

  it("carries the rejected session allocation ID for lifecycle-owned cleanup", async () => {
    const { provider, client } = fixture("modal");
    client.stopSandbox.mockRejectedValue(new Error("unreachable"));
    await expect(provider.createSandbox(config)).rejects.toMatchObject({
      name: "SandboxLaunchRejectedError",
      providerObjectId: "sb-1",
    });
    await expect(
      provider.restoreFromSnapshot({ ...config, snapshotImageId: "im-1" })
    ).rejects.toBeInstanceOf(SandboxLaunchRejectedError);
  });

  it.each([undefined, "modal", 42, { bad: true }])(
    "binds rejected build handles for cleanup but never starts them (%j)",
    async (value) => {
      const { provider, client } = fixture(value);
      const bind = vi.fn().mockResolvedValue(undefined);
      await expect(
        provider.triggerImageBuild({ ...build, onProviderSessionCreated: bind })
      ).rejects.toThrow("did not confirm");
      expect(bind).toHaveBeenCalledWith("sb-1");
      expect(client.startImageBuildSandbox).not.toHaveBeenCalled();
    }
  );

  it("starts a confirmed build only after binding", async () => {
    const { provider, client } = fixture("modal-vm");
    let bound = false;
    client.startImageBuildSandbox.mockImplementation(async () => expect(bound).toBe(true));
    await provider.triggerImageBuild({
      ...build,
      onProviderSessionCreated: async () => {
        bound = true;
      },
    });
    expect(client.startImageBuildSandbox).toHaveBeenCalledOnce();
  });

  it("preserves an allocation handle when wire confirmation is malformed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          success: true,
          data: { provider_session_id: "sb-1", sandbox_backend: { invalid: true } },
        })
      )
    );
    const client = createModalClient("test-secret", "workspace");
    const result = await client.createImageBuildSandbox({ ...build, sandboxBackend: "modal-vm" });
    expect(result).toMatchObject({ providerSessionId: "sb-1", sandboxBackend: { invalid: true } });
  });

  it("serializes backend and predecessor identity on create and restore HTTP requests", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        success: true,
        data: {
          sandbox_id: "sandbox-1",
          modal_object_id: "sb-1",
          created_at: 1,
          sandbox_backend: "modal-vm",
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);
    const client = createModalClient("test-secret", "workspace");
    await client.createSandbox({ ...config, sandboxBackend: "modal-vm" });
    fetchMock.mockResolvedValue(
      Response.json({
        success: true,
        data: { sandbox_id: "sandbox-1", modal_object_id: "sb-1", sandbox_backend: "modal-vm" },
      })
    );
    await client.restoreSandbox({ ...config, snapshotImageId: "im-1", sandboxBackend: "modal-vm" });
    for (const [, init] of fetchMock.mock.calls) {
      expect(JSON.parse(init.body)).toMatchObject({
        sandbox_backend: "modal-vm",
        retire_sandbox_id: "prior-generation",
      });
    }
  });

  it("requires explicit retirement confirmation for VM session captures", async () => {
    const { provider, client } = fixture("modal-vm");
    const input = { providerObjectId: "sb-1", sessionId: "session-1", reason: "checkpoint" };
    await expect(provider.takeSnapshot(input)).resolves.toMatchObject({
      success: true,
      sourceStopped: true,
    });
    client.snapshotSandbox.mockResolvedValue({ imageId: "im-1", sourceStopped: false });
    await expect(provider.takeSnapshot(input)).rejects.toThrow("did not confirm source retirement");
  });

  it.each(["modal", "modal-vm"])("keeps dashboard links for %s", (backend) => {
    expect(
      resolveSandboxDashboardUrl(
        { sandboxProvider: backend, modalWorkspace: "acme", modalEnvironment: "main" },
        "sb-1"
      )
    ).toContain("sandboxId=sb-1");
  });
});
