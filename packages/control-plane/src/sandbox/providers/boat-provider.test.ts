import { beforeEach, describe, expect, it, vi } from "vitest";
import { BoatNotFoundError, type BoatRestClient, type BoatSandbox } from "../boat-rest-client";
import { SandboxProviderError, type CreateSandboxConfig } from "../provider";
import {
  BoatSandboxProvider,
  resolveBoatSandboxType,
  validateBoatEnvironment,
} from "./boat-provider";

const created: BoatSandbox = {
  id: "bx_23456789",
  name: "Open Inspect",
  state: "provisioning",
  type: "small",
  createdAt: "2030-01-01T00:00:00.000Z",
  archiveAfter: "2030-01-01T02:00:00.000Z",
  snapshotAvailable: false,
};

const ready: BoatSandbox = { ...created, state: "ready" };

const baseConfig: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "logical-1",
  repoOwner: "acme",
  repoName: "widgets",
  controlPlaneUrl: "https://control.test",
  sandboxAuthToken: "sandbox-auth-secret",
  harness: "opencode",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  timeoutSeconds: 7200,
  branch: "main",
};

function mockClient(overrides: Partial<BoatRestClient> = {}): BoatRestClient {
  return {
    config: { apiKey: "boat-key", baseSnapshot: "oi-base" },
    requireBaseSnapshot: vi.fn(() => "oi-base"),
    createSandbox: vi.fn(async () => created),
    getSandbox: vi.fn(async () => ready),
    updateSandboxName: vi.fn(async () => ready),
    resumeSandbox: vi.fn(async () => {}),
    stopSandbox: vi.fn(async () => {}),
    startDetachedCommand: vi.fn(async () => ({
      success: true,
      processId: 42,
      pid: 42,
      command: "/opt/openinspect/bin/start-runtime",
      startedAt: "2030-01-01T00:00:00Z",
    })),
    getCommandStatus: vi.fn(async () => ({
      success: true,
      processId: 42,
      status: "running" as const,
      running: true,
      exitCode: null,
    })),
    hostPort: vi.fn(async (_id: string, port: number) => ({
      success: true,
      port,
      url: `https://boat.test/${port}?_token=private-${port}`,
      isProtected: true,
      access: "private" as const,
    })),
    writeTextFile: vi.fn(async () => {}),
    deleteSandbox: vi.fn(async () => ({
      id: "bdop_0123456789abcdef0123456789abcdef",
      kind: "sandbox" as const,
      targetId: created.id,
      status: "pending" as const,
      attemptCount: 0,
      requestedAt: "2030-01-01T00:00:00Z",
      completedAt: null,
    })),
    getDeletionOperation: vi.fn(),
    ...overrides,
  } as unknown as BoatRestClient;
}

function provider(client = mockClient()): BoatSandboxProvider {
  return new BoatSandboxProvider(client, {
    scmProvider: "github",
    sandboxAccessPasswordSecret: "stable-access-secret",
    defaultType: "default",
    deploymentName: "test-deployment",
  });
}

describe("BoatSandboxProvider", () => {
  beforeEach(() => vi.clearAllMocks());

  it("creates from the verified template, launches the fixed runtime, and returns access", async () => {
    const client = mockClient();
    const result = await provider(client).createSandbox({
      ...baseConfig,
      codeServerEnabled: true,
      vncEnabled: true,
      sandboxSettings: { terminalEnabled: true, tunnelPorts: [3000] },
    });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "default",
        ttlSeconds: 7200,
        from: "oi-base",
        idempotencyKey: expect.stringMatching(/^openinspect:[a-f0-9]{64}$/),
      })
    );
    const createParams = vi.mocked(client.createSandbox).mock.calls[0]![0];
    expect(createParams.env).toMatchObject({
      SANDBOX_ID: "logical-1",
      SANDBOX_AUTH_TOKEN: "sandbox-auth-secret",
      HOME: "/home/user",
      FROM_REPO_IMAGE: "false",
      RESTORED_FROM_SNAPSHOT: "false",
      EXPECTED_TUNNEL_PORTS: "3000",
    });
    expect(client.startDetachedCommand).toHaveBeenCalledWith(
      created.id,
      "/home/user/openinspect/start-runtime"
    );
    expect(client.writeTextFile).toHaveBeenCalledWith(
      created.id,
      "/home/user/openinspect/workspace/.tunnels.env",
      expect.stringContaining("TUNNEL_3000=https://boat.test/3000?_token=private-3000")
    );
    expect(result).toMatchObject({
      providerObjectId: created.id,
      lifetime: {
        kind: "finite",
        expiresAtMs: Date.parse("2030-01-01T02:00:00.000Z"),
        source: "provider",
      },
      codeServerUrl: "https://boat.test/8080?_token=private-8080",
      ttydUrl: "https://boat.test/7680?_token=private-7680",
      vncAccess: { url: "https://boat.test/6080?_token=private-6080" },
      tunnelUrls: { "3000": "https://boat.test/3000?_token=private-3000" },
    });
  });

  it("maps CPU and memory requests to the smallest public machine type", () => {
    expect(resolveBoatSandboxType("default", undefined)).toBe("default");
    expect(resolveBoatSandboxType("default", { cpuCores: 1, memoryMib: 1024 })).toBe("small");
    expect(resolveBoatSandboxType("small", { cpuCores: 4, memoryMib: 4096 })).toBe("default");
    expect(resolveBoatSandboxType("small", { cpuCores: 4, memoryMib: 9000 })).toBe("large");
    expect(() => resolveBoatSandboxType("default", { cpuCores: 16 })).toThrow(
      "exceeds the largest supported machine"
    );
  });

  it("enforces Boat environment limits without exposing values", () => {
    const tooMany = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [`K${index}`, "v"])
    );
    expect(() => validateBoatEnvironment(tooMany)).toThrow("101 variables");
    expect(() => validateBoatEnvironment({ "bad-key": "super-secret" })).toThrow("bad-key");
    expect(() => validateBoatEnvironment({ BIG: "x".repeat(65_536) })).toThrow("maximum is 65536");
    try {
      validateBoatEnvironment({ BIG: "secret-value".repeat(6_000) });
    } catch (error) {
      expect((error as Error).message).not.toContain("secret-value");
    }
  });

  it("rejects prebuilt images and out-of-range TTLs before creating", async () => {
    const client = mockClient();
    await expect(
      provider(client).createSandbox({ ...baseConfig, prebuiltImageId: "repo-image" })
    ).rejects.toThrow("does not support repository or environment prebuilt images");
    await expect(
      provider(client).createSandbox({ ...baseConfig, timeoutSeconds: 2_592_001 })
    ).rejects.toThrow("1 to 2592000 seconds");
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("fails instead of accepting a successful launch without a finite provider deadline", async () => {
    const getSandbox = vi
      .fn()
      .mockResolvedValueOnce({ ...ready, archiveAfter: null })
      .mockRejectedValueOnce(new BoatNotFoundError("gone"));
    const client = mockClient({ getSandbox });
    await expect(provider(client).createSandbox(baseConfig)).rejects.toMatchObject({
      errorType: "transient",
      message: expect.stringContaining("archiveAfter"),
    });
    expect(client.deleteSandbox).toHaveBeenCalled();
  });

  it("keeps optional host failures from hiding a healthy sandbox", async () => {
    const client = mockClient({
      hostPort: vi.fn(async (_id: string, port: number) => {
        if (port === 8080) throw new Error("host unavailable");
        return {
          success: true,
          port,
          url: `https://boat.test/${port}?_token=private`,
          isProtected: true,
          access: "private" as const,
        };
      }),
    });
    const result = await provider(client).createSandbox({ ...baseConfig, codeServerEnabled: true });
    expect(result.providerObjectId).toBe(created.id);
    expect(result.codeServerUrl).toBeUndefined();
  });

  it("deletes a created sandbox when mandatory runtime launch fails", async () => {
    const getSandbox = vi
      .fn()
      .mockResolvedValueOnce(ready)
      .mockRejectedValueOnce(new BoatNotFoundError("gone"));
    const client = mockClient({
      getSandbox,
      startDetachedCommand: vi.fn(async () => {
        throw new SandboxProviderError("launch failed", "permanent");
      }),
    });
    await expect(provider(client).createSandbox(baseConfig)).rejects.toThrow("launch failed");
    expect(client.deleteSandbox).toHaveBeenCalledWith(created.id, undefined);
  });

  it("resumes a stopped sandbox, relaunches the runtime, and refreshes lifetime", async () => {
    const stopped = { ...ready, state: "stopped", snapshotAvailable: true };
    const resumed = { ...ready, archiveAfter: "2030-01-01T04:00:00.000Z" };
    const client = mockClient({
      getSandbox: vi
        .fn()
        .mockResolvedValueOnce(stopped)
        .mockResolvedValueOnce(resumed)
        .mockResolvedValueOnce(resumed),
    });
    const result = await provider(client).resumeSandbox({
      providerObjectId: created.id,
      sessionId: "session-1",
      sandboxId: "logical-1",
      timeoutSeconds: 3600,
    });
    expect(client.resumeSandbox).toHaveBeenCalledWith(created.id, {
      type: "default",
      ttlSeconds: 3600,
    });
    expect(client.startDetachedCommand).toHaveBeenCalledWith(
      created.id,
      "/home/user/openinspect/start-runtime"
    );
    expect(result).toMatchObject({
      success: true,
      providerObjectId: created.id,
      lifetime: { expiresAtMs: Date.parse("2030-01-01T04:00:00.000Z") },
    });
  });

  it("returns a fresh-spawn decision only for a confirmed missing sandbox", async () => {
    const client = mockClient({
      getSandbox: vi.fn(async () => {
        throw new BoatNotFoundError("gone");
      }),
    });
    await expect(
      provider(client).resumeSandbox({
        providerObjectId: created.id,
        sessionId: "session-1",
        sandboxId: "logical-1",
      })
    ).resolves.toMatchObject({ success: false, shouldSpawnFresh: true });
  });

  it("does not replace retained state in an error state", async () => {
    const client = mockClient({ getSandbox: vi.fn(async () => ({ ...ready, state: "error" })) });
    const result = await provider(client).resumeSandbox({
      providerObjectId: created.id,
      sessionId: "session-1",
      sandboxId: "logical-1",
    });
    expect(result).toMatchObject({ success: false });
    expect(result).not.toHaveProperty("shouldSpawnFresh");
  });
});
