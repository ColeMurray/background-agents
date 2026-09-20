import { afterEach, describe, expect, it, vi } from "vitest";
import { createModalClient, type CreateSandboxRequest } from "./client";

const execution = {
  profile: "docker-v1",
  provider: "modal",
  cpuCores: 2,
  memoryMib: 4096,
} as const;
const request: CreateSandboxRequest = {
  sessionId: "session-1",
  sandboxId: "logical-1",
  repoOwner: null,
  repoName: null,
  controlPlaneUrl: "https://cp.test",
  sandboxAuthToken: "token",
  harness: "opencode",
};
const allocation = {
  success: true,
  data: {
    sandbox_id: "logical-1",
    modal_object_id: "sb-Owned123",
    created_at: 1,
    execution_profile: "docker-v1",
  },
};
const client = () => createModalClient("secret", "acme", undefined, "http://modal.test");
afterEach(() => vi.restoreAllMocks());

describe("Modal VM wire contract", () => {
  it.each(["ambiguous", "cleanup-failed"] as const)(
    "logs only allocation ownership when %s",
    async (failure) => {
      const logs = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetch = vi.spyOn(globalThis, "fetch");
      if (failure === "ambiguous") fetch.mockResolvedValueOnce(Response.json({ success: true }));
      else
        fetch
          .mockResolvedValueOnce(
            Response.json({
              ...allocation,
              data: { ...allocation.data, execution_profile: "default" },
            })
          )
          .mockRejectedValueOnce(new Error("network"));
      await expect(
        client().createSandbox({
          ...request,
          sandboxExecution: execution,
          sandboxAuthToken: "sandbox-token-must-not-be-logged",
          userEnvVars: { PRIVATE_KEY: "repository-secret-must-not-be-logged" },
        })
      ).rejects.toThrow();
      const output = JSON.stringify(logs.mock.calls);
      expect(output).toContain("session-1");
      expect(output).not.toContain("sandbox-token-must-not-be-logged");
      expect(output).not.toContain("repository-secret-must-not-be-logged");
      expect(output).not.toContain("userEnvVars");
    }
  );

  it("rejects Docker creation without a generation before any allocation", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    await expect(
      client().createSandbox({ ...request, sandboxId: undefined, sandboxExecution: execution })
    ).rejects.toThrow("requires a control-plane sandbox generation");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("uses legacy endpoints without sending the new execution field for default sessions", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(allocation));
    await client().createSandbox({ ...request, sandboxExecution: { profile: "default" } });
    expect(fetch.mock.calls[0][0]).toBe("http://modal.test/api-create-sandbox");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).not.toHaveProperty(
      "sandbox_execution"
    );
  });
  it("requires a versioned launch and echoed profile for Docker", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(allocation));
    await expect(
      client().createSandbox({ ...request, sandboxExecution: execution })
    ).resolves.toMatchObject({ modalObjectId: "sb-Owned123" });
    expect(fetch.mock.calls[0][0]).toBe("http://modal.test/api-create-sandbox-v2");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string).sandbox_execution).toEqual(execution);
  });
  it.each([
    { execution_profile: "default" },
    { execution_profile: undefined },
    { sandbox_id: "wrong-generation" },
    { created_at: "invalid" },
  ])("compensates known allocations on invalid response %j", async (override) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ ...allocation, data: { ...allocation.data, ...override } })
      )
      .mockResolvedValueOnce(Response.json({ success: true }));
    await expect(
      client().createSandbox({ ...request, sandboxExecution: execution })
    ).rejects.toThrow("Modal VM allocation response");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1][0]).toBe("http://modal.test/api-terminate-sandbox");
    expect(JSON.parse(fetch.mock.calls[1][1]!.body as string)).toEqual({
      provider_object_id: "sb-Owned123",
      session_id: "session-1",
      sandbox_id: "logical-1",
    });
  });
  it("reports the known allocation when compensation fails", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        Response.json({ ...allocation, data: { ...allocation.data, execution_profile: "default" } })
      )
      .mockRejectedValueOnce(new Error("network"));
    await expect(
      client().createSandbox({ ...request, sandboxExecution: execution })
    ).rejects.toThrow("cleanup required for sb-Owned123");
  });
  it("uses the image deletion endpoint's exact request field", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ success: true }));
    await client().deleteProviderImage("im-Artifact123");
    expect(fetch.mock.calls[0][0]).toBe("http://modal.test/api-delete-image");
    expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
      image_id: "im-Artifact123",
    });
  });
});
