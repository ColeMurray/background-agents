/**
 * Unit tests for IsloSandboxProvider.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { IsloApiError, type IsloApi } from "@islo-labs/sdk";
import { computeHmacHex } from "@open-inspect/shared";
import { IsloSandboxProvider, type IsloClientLike, type IsloProviderConfig } from "./islo-provider";
import { type CreateSandboxConfig, type ResumeConfig } from "../provider";

const SHARE_DELAY_TIMEOUT_MS = 50;

const defaultProviderConfig: IsloProviderConfig = {
  apiKey: "islo-api-key",
  baseSnapshot: "open-inspect-runtime",
  vcpus: 4,
  memoryMb: 8192,
  diskGb: 20,
  scmProvider: "github",
  codeServerPasswordSecret: "password-secret",
};

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-owner-repo-123",
  repoOwner: "owner",
  repoName: "repo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "sandbox-token",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

const baseResumeConfig: ResumeConfig = {
  providerObjectId: "sandbox-owner-repo-123",
  sessionId: "session-123",
  sandboxId: "sandbox-owner-repo-123",
};

function sandboxResponse(
  overrides: Partial<IsloApi.SandboxResponse> = {}
): IsloApi.SandboxResponse {
  return {
    id: "islo-sandbox-id",
    name: "sandbox-owner-repo-123",
    status: "running",
    image: "ghcr.io/open-inspect/sandbox-runtime:latest",
    spec: { vcpus: 4, memory_mb: 8192, disk_gb: 20 },
    created_at: "2026-06-03T08:00:00.000Z",
    ...overrides,
  };
}

function createMockClient(
  overrides: Partial<{
    createSandbox: IsloClientLike["sandboxes"]["createSandbox"];
    getSandbox: IsloClientLike["sandboxes"]["getSandbox"];
    resumeSandbox: IsloClientLike["sandboxes"]["resumeSandbox"];
    pauseSandbox: IsloClientLike["sandboxes"]["pauseSandbox"];
    execInSandbox: IsloClientLike["sandboxes"]["execInSandbox"];
    getExecResult: IsloClientLike["sandboxes"]["getExecResult"];
    listShares: IsloClientLike["shares"]["listShares"];
    createShare: IsloClientLike["shares"]["createShare"];
  }> = {}
): IsloClientLike {
  const execInSandbox = vi
    .fn()
    .mockResolvedValueOnce({
      exec_id: "write-tunnels",
      status: "running",
      sandbox_id: "islo-sandbox-id",
    })
    .mockResolvedValue({
      exec_id: "start-runtime",
      status: "running",
      sandbox_id: "islo-sandbox-id",
    });

  return {
    fetch: vi.fn(async () => new Response(null, { status: 200 })),
    sandboxes: {
      createSandbox: vi.fn(async () => sandboxResponse()),
      getSandbox: vi.fn(async () => sandboxResponse()),
      resumeSandbox: vi.fn(async () => sandboxResponse()),
      pauseSandbox: vi.fn(async () => sandboxResponse({ status: "paused" })),
      execInSandbox,
      getExecResult: vi.fn(async () => ({
        exec_id: "write-tunnels",
        status: "completed",
        exit_code: 0,
      })),
      ...pickSandboxOverrides(overrides),
    },
    shares: {
      listShares: vi.fn(async () => []),
      createShare: vi.fn(async (request) => ({
        share_id: `share-${request.port}`,
        url: `https://share.test/${request.port}`,
        port: request.port,
        created_at: "2026-06-03T08:00:00.000Z",
        expires_at: "2026-06-04T08:00:00.000Z",
      })),
      ...(overrides.listShares ? { listShares: overrides.listShares } : {}),
      ...(overrides.createShare ? { createShare: overrides.createShare } : {}),
    },
  };
}

function pickSandboxOverrides(
  overrides: Parameters<typeof createMockClient>[0] = {}
): Partial<IsloClientLike["sandboxes"]> {
  return {
    ...(overrides.createSandbox ? { createSandbox: overrides.createSandbox } : {}),
    ...(overrides.getSandbox ? { getSandbox: overrides.getSandbox } : {}),
    ...(overrides.resumeSandbox ? { resumeSandbox: overrides.resumeSandbox } : {}),
    ...(overrides.pauseSandbox ? { pauseSandbox: overrides.pauseSandbox } : {}),
    ...(overrides.execInSandbox ? { execInSandbox: overrides.execInSandbox } : {}),
    ...(overrides.getExecResult ? { getExecResult: overrides.getExecResult } : {}),
  };
}

describe("IsloSandboxProvider", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reports Islo capabilities", () => {
    const provider = new IsloSandboxProvider(createMockClient(), defaultProviderConfig);

    expect(provider.name).toBe("islo");
    expect(provider.capabilities).toEqual({
      supportsSnapshots: false,
      supportsRestore: false,
      supportsWarm: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
  });

  it("creates a sandbox, shares requested ports, writes tunnel env, and starts runtime", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    const result = await provider.createSandbox({
      ...baseCreateConfig,
      codeServerEnabled: true,
      agentSlackNotifyEnabled: true,
      mcpServers: [
        {
          id: "mcp-docs",
          name: "docs",
          type: "local",
          command: ["npx", "docs-mcp"],
          enabled: true,
        },
      ],
      sandboxSettings: {
        terminalEnabled: true,
        tunnelPorts: [3000, 5173],
      },
    });

    expect(result).toMatchObject({
      sandboxId: "sandbox-owner-repo-123",
      providerObjectId: "sandbox-owner-repo-123",
      status: "running",
      codeServerUrl: "https://share.test/8080",
      ttydUrl: "https://share.test/7680",
      tunnelUrls: {
        "3000": "https://share.test/3000",
        "5173": "https://share.test/5173",
      },
    });

    expect(client.sandboxes.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "sandbox-owner-repo-123",
        snapshot_name: "open-inspect-runtime",
        vcpus: 4,
        memory_mb: 8192,
        disk_gb: 20,
        workdir: "/workspace",
        init: { type: "minimal" },
      }),
      { timeoutInSeconds: undefined }
    );

    const createRequest = vi.mocked(client.sandboxes.createSandbox).mock.calls[0][0];
    expect(createRequest).not.toHaveProperty("setup_scripts");
    expect(createRequest.env).toMatchObject({
      HOME: "/workspace",
      PYTHONPATH: "/app",
      PYTHONUNBUFFERED: "1",
      NODE_PATH: "/usr/lib/node_modules",
      SANDBOX_ID: "sandbox-owner-repo-123",
      CONTROL_PLANE_URL: "https://control-plane.test",
      SANDBOX_AUTH_TOKEN: "sandbox-token",
      REPO_OWNER: "owner",
      REPO_NAME: "repo",
      AGENT_SLACK_NOTIFY_ENABLED: "true",
      TERMINAL_ENABLED: "true",
      EXPECTED_TUNNEL_PORTS: "3000,5173",
      VCS_HOST: "github.com",
      VCS_CLONE_USERNAME: "x-access-token",
    });
    expect(createRequest.env.PATH).toContain("/usr/local/bin");
    expect(createRequest.env.GITHUB_TOKEN).toBeUndefined();
    expect(JSON.parse(createRequest.env.SESSION_CONFIG)).toMatchObject({
      session_id: "session-123",
      sessionId: "session-123",
      repo_owner: "owner",
      repo_name: "repo",
      mcp_servers: [
        {
          id: "mcp-docs",
          name: "docs",
          type: "local",
          command: ["npx", "docs-mcp"],
          enabled: true,
        },
      ],
    });

    const expectedPassword = (
      await computeHmacHex("code-server:sandbox-owner-repo-123", "password-secret")
    ).slice(0, 32);
    expect(createRequest.env.CODE_SERVER_PASSWORD).toBe(expectedPassword);

    expect(client.shares.createShare).toHaveBeenCalledTimes(4);
    expect(client.shares.createShare).toHaveBeenCalledWith({
      sandbox_name: "sandbox-owner-repo-123",
      port: 8080,
      ttl_seconds: 86400,
    });

    expect(client.shares.listShares).not.toHaveBeenCalled();

    const execCalls = vi.mocked(client.sandboxes.execInSandbox).mock.calls;
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0][0].body.command.join(" ")).toContain("TUNNEL_3000");
    expect(execCalls[0][0].body.command.join(" ")).toContain("TUNNEL_5173");
    expect(execCalls[1][0]).toMatchObject({
      sandbox_name: "sandbox-owner-repo-123",
      body: {
        command: expect.arrayContaining(["sh", "-lc"]),
        workdir: "/workspace",
      },
    });
    const startRuntimeCommand = execCalls[1][0].body.command.join(" ");
    expect(startRuntimeCommand).toContain("nohup");
    expect(startRuntimeCommand).toContain("sandbox_runtime.entrypoint");
    expect(startRuntimeCommand).toContain("kill -0");
    expect(startRuntimeCommand).not.toContain("sleep 2");
  });

  it("starts runtime in parallel with share creation when tunnel env is not required", async () => {
    const order: string[] = [];
    const client = createMockClient({
      createShare: vi.fn(async (request) => {
        order.push("share-start");
        await new Promise((resolve) => setTimeout(resolve, SHARE_DELAY_TIMEOUT_MS));
        order.push("share-end");
        return {
          share_id: `share-${request.port}`,
          url: `https://share.test/${request.port}`,
          port: request.port,
          created_at: "2026-06-03T08:00:00.000Z",
          expires_at: "2026-06-04T08:00:00.000Z",
        };
      }),
      execInSandbox: vi.fn(async () => {
        order.push("runtime-start");
        return {
          exec_id: "start-runtime",
          status: "running",
          sandbox_id: "islo-sandbox-id",
        };
      }),
    });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    await provider.createSandbox({
      ...baseCreateConfig,
      codeServerEnabled: true,
    });

    expect(order).toContain("runtime-start");
    expect(order.indexOf("runtime-start")).toBeLessThan(order.indexOf("share-end"));
    expect(vi.mocked(client.sandboxes.execInSandbox)).toHaveBeenCalledTimes(1);
  });

  it("waits through Islo share creation not-running readiness errors", async () => {
    let attempts = 0;
    const createShare = vi.fn(async (request: IsloApi.CreateShareRequest) => {
      attempts += 1;
      if (attempts === 1) {
        throw new IsloApiError({
          statusCode: 400,
          message:
            'Status code: 400\nBody: {"code":"INVALID_REQUEST","message":"Sandbox is not running"}',
        });
      }

      return {
        share_id: `share-${request.port}`,
        url: `https://share.test/${request.port}`,
        port: request.port,
        created_at: "2026-06-03T08:00:00.000Z",
        expires_at: "2026-06-04T08:00:00.000Z",
      };
    });
    const client = createMockClient({ createShare });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    const result = await provider.createSandbox({
      ...baseCreateConfig,
      codeServerEnabled: true,
    });

    expect(result.codeServerUrl).toBe("https://share.test/8080");
    expect(createShare).toHaveBeenCalledTimes(2);
  });

  it("uses GitLab clone metadata when configured", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, {
      ...defaultProviderConfig,
      scmProvider: "gitlab",
    });

    await provider.createSandbox(baseCreateConfig);

    const env = vi.mocked(client.sandboxes.createSandbox).mock.calls[0][0].env;
    expect(env.VCS_HOST).toBe("gitlab.com");
    expect(env.VCS_CLONE_USERNAME).toBe("oauth2");
  });

  it("resumes a paused sandbox and refreshes share URLs", async () => {
    const client = createMockClient({
      getSandbox: async () => sandboxResponse({ status: "paused" }),
    });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    const result = await provider.resumeSandbox({
      ...baseResumeConfig,
      codeServerEnabled: true,
      sandboxSettings: { terminalEnabled: true },
    });

    expect(result.success).toBe(true);
    expect(result.providerObjectId).toBe("sandbox-owner-repo-123");
    expect(client.sandboxes.resumeSandbox).toHaveBeenCalledWith({
      sandbox_name: "sandbox-owner-repo-123",
    });
    expect(result.codeServerUrl).toBe("https://share.test/8080");
  });

  it("returns shouldSpawnFresh when resume target is missing", async () => {
    const client = createMockClient({
      getSandbox: async () => {
        throw new IsloApiError({ statusCode: 404, message: "not found" });
      },
    });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    const result = await provider.resumeSandbox(baseResumeConfig);

    expect(result.success).toBe(false);
    expect(result.shouldSpawnFresh).toBe(true);
  });

  it("pauses sandbox on stop and treats missing sandbox as already stopped", async () => {
    const client = createMockClient({
      pauseSandbox: async () => {
        throw new IsloApiError({ statusCode: 404, message: "not found" });
      },
    });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    const result = await provider.stopSandbox({
      providerObjectId: "sandbox-owner-repo-123",
      sessionId: "session-123",
      reason: "inactivity_timeout",
    });

    expect(result.success).toBe(true);
  });

  it("classifies Islo 503 errors as transient provider errors", async () => {
    const client = createMockClient({
      createSandbox: async () => {
        throw new IsloApiError({ statusCode: 503, message: "unavailable" });
      },
    });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      errorType: "transient",
    });
  });
});
