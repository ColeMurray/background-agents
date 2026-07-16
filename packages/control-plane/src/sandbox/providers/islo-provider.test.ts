/**
 * Unit tests for IsloSandboxProvider.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { IsloApiError, type IsloApi } from "@islo-labs/sdk";
import { computeHmacHex } from "@open-inspect/shared";
import {
  createDefaultIsloSource,
  createIsloProvider,
  IsloSandboxProvider,
  type IsloClientLike,
  type IsloProviderConfig,
} from "./islo-provider";
import { type CreateSandboxConfig, type ResumeConfig } from "../provider";

const SHARE_DELAY_TIMEOUT_MS = 50;

const defaultProviderConfig: IsloProviderConfig = {
  apiKey: "islo-api-key",
  baseSource: { type: "snapshot", snapshotName: "open-inspect-runtime" },
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
    deleteSandbox: IsloClientLike["sandboxes"]["deleteSandbox"];
    execInSandbox: IsloClientLike["sandboxes"]["execInSandbox"];
    getExecResult: IsloClientLike["sandboxes"]["getExecResult"];
    createSnapshot: IsloClientLike["snapshots"]["createSnapshot"];
    getSnapshot: IsloClientLike["snapshots"]["getSnapshot"];
    deleteSnapshot: IsloClientLike["snapshots"]["deleteSnapshot"];
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
      deleteSandbox: vi.fn(async () => undefined),
      execInSandbox,
      getExecResult: vi.fn(async () => ({
        exec_id: "write-tunnels",
        status: "completed",
        exit_code: 0,
        stdout: "",
        stderr: "",
        truncated: false,
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
    snapshots: {
      createSnapshot: vi.fn(async () => ({
        id: "snapshot-id",
        name: "snapshot-name",
        status: "ready",
      })),
      getSnapshot: vi.fn(async () => ({
        id: "snapshot-id",
        name: "snapshot-name",
        status: "ready",
      })),
      deleteSnapshot: vi.fn(async () => undefined),
      ...(overrides.createSnapshot ? { createSnapshot: overrides.createSnapshot } : {}),
      ...(overrides.getSnapshot ? { getSnapshot: overrides.getSnapshot } : {}),
      ...(overrides.deleteSnapshot ? { deleteSnapshot: overrides.deleteSnapshot } : {}),
    },
  };
}

function requireCreateEnv(client: IsloClientLike): Record<string, string> {
  const env = vi.mocked(client.sandboxes.createSandbox).mock.calls[0][0].env;
  if (!env) throw new Error("Expected createSandbox env");
  return env as Record<string, string>;
}

function pickSandboxOverrides(
  overrides: Parameters<typeof createMockClient>[0] = {}
): Partial<IsloClientLike["sandboxes"]> {
  return {
    ...(overrides.createSandbox ? { createSandbox: overrides.createSandbox } : {}),
    ...(overrides.getSandbox ? { getSandbox: overrides.getSandbox } : {}),
    ...(overrides.resumeSandbox ? { resumeSandbox: overrides.resumeSandbox } : {}),
    ...(overrides.pauseSandbox ? { pauseSandbox: overrides.pauseSandbox } : {}),
    ...(overrides.deleteSandbox ? { deleteSandbox: overrides.deleteSandbox } : {}),
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
      supportsSnapshots: true,
      supportsRestore: true,
      supportsWarm: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
  });

  it("defaults fresh Islo sandboxes to the maintained Background Agents runtime image", () => {
    expect(createDefaultIsloSource()).toEqual({
      type: "image",
      image: "ghcr.io/islo-labs/background-agents-runtime:stable",
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
    const env = requireCreateEnv(client);
    expect(createRequest).not.toHaveProperty("setup_scripts");
    expect(env).toMatchObject({
      HOME: "/workspace",
      PYTHONPATH: "/app",
      PYTHONUNBUFFERED: "1",
      NODE_PATH: "/usr/lib/node_modules",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
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
      IMAGE_BUILD_MODE: "false",
      OI_REPO_IMAGE_BUILD_ID: "",
      OI_REPO_IMAGE_CALLBACK_URL: "",
      OI_REPO_IMAGE_CALLBACK_TOKEN: "",
      OI_REPO_IMAGE_PROVIDER_SESSION_ID: "",
    });
    expect(env.PATH).toContain("/usr/local/bin");
    expect(env.GITHUB_TOKEN).toBeUndefined();
    expect(JSON.parse(env.SESSION_CONFIG)).toMatchObject({
      session_id: "session-123",
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
    expect(env.CODE_SERVER_PASSWORD).toBe(expectedPassword);

    expect(client.shares.createShare).toHaveBeenCalledTimes(4);
    expect(client.shares.createShare).toHaveBeenCalledWith(
      {
        sandbox_name: "sandbox-owner-repo-123",
        port: 8080,
        ttl_seconds: 86400,
      },
      expect.objectContaining({ timeoutInSeconds: expect.any(Number) })
    );

    expect(client.shares.listShares).not.toHaveBeenCalled();

    const execCalls = vi.mocked(client.sandboxes.execInSandbox).mock.calls;
    expect(execCalls).toHaveLength(3);
    const preflightCommand = execCalls[0][0].command.join(" ");
    expect(preflightCommand).toContain("import sandbox_runtime.entrypoint");
    expect(preflightCommand).toContain("opencode --version");
    expect(preflightCommand).toContain("agent-browser --version");
    expect(preflightCommand).toContain("AGENT_BROWSER_EXECUTABLE_PATH");
    expect(preflightCommand).toContain("--headless");
    expect(preflightCommand).toContain("code-server --version");
    expect(preflightCommand).toContain("ttyd --version");
    expect(execCalls[0][0].env).toMatchObject({
      HOME: "/workspace",
      PYTHONPATH: "/app",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
    });
    expect(execCalls[1][0].command.join(" ")).toContain("TUNNEL_3000");
    expect(execCalls[1][0].command.join(" ")).toContain("TUNNEL_5173");
    expect(execCalls[2][0]).toMatchObject({
      sandbox_name: "sandbox-owner-repo-123",
      command: expect.arrayContaining(["sh", "-lc"]),
      workdir: "/workspace",
    });
    const startRuntimeCommand = execCalls[2][0].command.join(" ");
    expect(startRuntimeCommand).toContain("nohup");
    expect(startRuntimeCommand).toContain("sandbox_runtime.entrypoint");
    expect(startRuntimeCommand).toContain("kill -0");
    expect(startRuntimeCommand).not.toContain("sleep 2");
  });

  it("creates from an image source when no base snapshot is configured", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, {
      ...defaultProviderConfig,
      baseSource: { type: "image", image: "ghcr.io/islo-labs/background-agents-runtime:stable" },
    });

    await provider.createSandbox(baseCreateConfig);

    const createRequest = vi.mocked(client.sandboxes.createSandbox).mock.calls[0][0];
    expect(createRequest).toMatchObject({
      image: "ghcr.io/islo-labs/background-agents-runtime:stable",
    });
    expect(createRequest).not.toHaveProperty("snapshot_name");
  });

  it("fails early when the Islo image is missing the Background Agents runtime", async () => {
    const client = createMockClient({
      getExecResult: vi.fn(async () => ({
        exec_id: "runtime-preflight",
        status: "failed",
        exit_code: 127,
        stdout: "",
        stderr: "python3: No module named sandbox_runtime",
        truncated: false,
      })),
    });
    const provider = new IsloSandboxProvider(client, {
      ...defaultProviderConfig,
      baseSource: { type: "image", image: "ghcr.io/islo-labs/islo-runner:latest" },
    });

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      message: expect.stringContaining('Failed Islo step "runtime_preflight"'),
    });
    expect(client.shares.createShare).not.toHaveBeenCalled();
    expect(client.sandboxes.pauseSandbox).toHaveBeenCalledWith({
      sandbox_name: "sandbox-owner-repo-123",
    });
  });

  it("prefers repo image snapshots over the base source", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, {
      ...defaultProviderConfig,
      baseSource: { type: "image", image: "ghcr.io/islo-labs/background-agents-runtime:stable" },
    });

    await provider.createSandbox({
      ...baseCreateConfig,
      repoImageId: "repo-image-snapshot",
      repoImageSha: "abc123",
    });

    const createRequest = vi.mocked(client.sandboxes.createSandbox).mock.calls[0][0];
    expect(createRequest).toMatchObject({
      snapshot_name: "repo-image-snapshot",
    });
    expect(createRequest).not.toHaveProperty("image");
    expect(requireCreateEnv(client)).toMatchObject({
      FROM_REPO_IMAGE: "true",
      REPO_IMAGE_SHA: "abc123",
      IMAGE_BUILD_MODE: "false",
    });
  });

  it("passes configured Islo lifecycle policy at create time", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, {
      ...defaultProviderConfig,
      lifecycle: {
        pause_after_idle: 3600,
        pause_after: 7200,
        delete_after: 86400,
        auto_resume: "on_activity",
      },
    });

    await provider.createSandbox(baseCreateConfig);

    expect(vi.mocked(client.sandboxes.createSandbox).mock.calls[0][0]).toMatchObject({
      lifecycle: {
        pause_after_idle: 3600,
        pause_after: 7200,
        delete_after: 86400,
        auto_resume: "on_activity",
      },
    });
  });

  it("restores from an Islo snapshot and restarts runtime", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    const result = await provider.restoreFromSnapshot({
      snapshotImageId: "saved-snapshot",
      ...baseCreateConfig,
    });

    expect(result.success).toBe(true);
    expect(client.sandboxes.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "sandbox-owner-repo-123",
        snapshot_name: "saved-snapshot",
        env: expect.objectContaining({
          RESTORED_FROM_SNAPSHOT: "true",
          IMAGE_BUILD_MODE: "false",
        }),
      }),
      { timeoutInSeconds: undefined }
    );
    expect(client.sandboxes.execInSandbox).toHaveBeenCalled();
  });

  it("takes Islo snapshots and returns the snapshot name", async () => {
    const client = createMockClient({
      createSnapshot: vi.fn(async () => ({
        id: "snapshot-id",
        name: "snapshot-session",
        status: "ready",
      })),
    });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    const result = await provider.takeSnapshot({
      providerObjectId: "sandbox-owner-repo-123",
      sessionId: "session-123",
      reason: "execution_complete",
    });

    expect(result).toEqual({ success: true, imageId: "snapshot-session" });
    expect(client.snapshots.createSnapshot).toHaveBeenCalledWith({
      sandbox_name: "sandbox-owner-repo-123",
      name: expect.stringMatching(/^oi-session-123-execution-complete-/),
    });
  });

  it("waits for Islo snapshots that are still processing", async () => {
    const client = createMockClient({
      createSnapshot: vi.fn(async () => ({
        id: "snapshot-id",
        name: "snapshot-session",
        status: "processing",
      })),
      getSnapshot: vi.fn(async () => ({
        id: "snapshot-id",
        name: "snapshot-session",
        status: "ready",
      })),
    });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    const result = await provider.takeSnapshot({
      providerObjectId: "sandbox-owner-repo-123",
      sessionId: "session-123",
      reason: "repo_image",
    });

    expect(result).toEqual({ success: true, imageId: "snapshot-session" });
    expect(client.snapshots.getSnapshot).toHaveBeenCalledWith(
      { name: "snapshot-session" },
      expect.objectContaining({ timeoutInSeconds: expect.any(Number) })
    );
  });

  it("triggers repo image builds in an Islo sandbox", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);
    const onProviderSessionCreated = vi.fn();

    const result = await provider.triggerRepoImageBuild({
      buildId: "build-123",
      repoOwner: "owner",
      repoName: "repo",
      defaultBranch: "main",
      callbackUrl: "https://control-plane.test/repo-images/build-complete",
      callbackToken: "callback-token",
      userEnvVars: {
        USER_SECRET: "value",
        OI_REPO_IMAGE_CALLBACK_TOKEN: "user-controlled",
        OI_REPO_IMAGE_CALLBACK_SECRET: "legacy-user-controlled",
      },
      cloneToken: "clone-token",
      onProviderSessionCreated,
    });

    expect(result).toEqual({ buildId: "build-123", status: "building" });
    expect(onProviderSessionCreated).toHaveBeenCalledWith("sandbox-owner-repo-123");
    expect(requireCreateEnv(client)).toMatchObject({
      USER_SECRET: "value",
      IMAGE_BUILD_MODE: "true",
      AGENT_BROWSER_EXECUTABLE_PATH: "/usr/bin/chromium",
      SESSION_CONFIG: JSON.stringify({ branch: "main" }),
      OI_REPO_IMAGE_BUILD_ID: "build-123",
      OI_REPO_IMAGE_CALLBACK_URL: "https://control-plane.test/repo-images/build-complete",
      OI_REPO_IMAGE_CALLBACK_TOKEN: "callback-token",
      VCS_CLONE_TOKEN: "clone-token",
    });
    expect(requireCreateEnv(client)).not.toHaveProperty("OI_REPO_IMAGE_CALLBACK_SECRET");
    const startEnv = vi
      .mocked(client.sandboxes.execInSandbox)
      .mock.calls.map(([request]) => request.env as Record<string, string> | undefined)
      .find((env) => env?.OI_REPO_IMAGE_PROVIDER_SESSION_ID);
    if (!startEnv) throw new Error("Expected repo image runtime start env");
    expect(startEnv).toMatchObject({
      OI_REPO_IMAGE_PROVIDER_SESSION_ID: "sandbox-owner-repo-123",
    });
  });

  it("creates a sandbox for repository-less sessions without null env values", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    await provider.createSandbox({
      ...baseCreateConfig,
      repoOwner: null,
      repoName: null,
    });

    const env = requireCreateEnv(client);
    expect(env.REPO_OWNER).toBe("");
    expect(env.REPO_NAME).toBe("");
    expect(Object.values(env).every((value) => typeof value === "string")).toBe(true);
    expect(JSON.parse(env.SESSION_CONFIG)).toMatchObject({
      repo_owner: null,
      repo_name: null,
    });
  });

  it("does not ask runtime to wait for code-server and ttyd share ports", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    await provider.createSandbox({
      ...baseCreateConfig,
      codeServerEnabled: true,
      sandboxSettings: {
        terminalEnabled: true,
        tunnelPorts: [8080, 7680, 3000],
      },
    });

    expect(requireCreateEnv(client).EXPECTED_TUNNEL_PORTS).toBe("3000");

    const sharePorts = vi
      .mocked(client.shares.createShare)
      .mock.calls.map(([request]) => request.port);
    expect(sharePorts).toEqual([8080, 7680, 3000]);

    const tunnelWriteCommand = vi
      .mocked(client.sandboxes.execInSandbox)
      .mock.calls.map(([request]) => request.command.join(" "))
      .find((command) => command.includes("TUNNEL_3000"));
    if (!tunnelWriteCommand) throw new Error("Expected tunnel write command");
    expect(tunnelWriteCommand).toContain("TUNNEL_3000");
    expect(tunnelWriteCommand).not.toContain("TUNNEL_8080");
    expect(tunnelWriteCommand).not.toContain("TUNNEL_7680");
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
      execInSandbox: vi.fn(async (request: IsloApi.ExecRequest) => {
        order.push(request.command.join(" ").includes("nohup") ? "runtime-start" : "preflight");
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
    expect(vi.mocked(client.sandboxes.execInSandbox)).toHaveBeenCalledTimes(2);
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
    expect(vi.mocked(client.shares.createShare).mock.calls[0][1]).toMatchObject({
      timeoutInSeconds: expect.any(Number),
    });
    expect(createShare).toHaveBeenCalledTimes(2);
  });

  it("pauses an Islo sandbox when create fails after sandbox creation", async () => {
    const client = createMockClient({
      createShare: vi.fn(async () => {
        throw new Error("share unavailable");
      }),
    });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    await expect(
      provider.createSandbox({
        ...baseCreateConfig,
        codeServerEnabled: true,
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("Failed Islo step"),
    });

    expect(client.sandboxes.pauseSandbox).toHaveBeenCalledWith({
      sandbox_name: "sandbox-owner-repo-123",
    });
  });

  it("uses GitLab clone metadata when configured", async () => {
    const client = createMockClient();
    const provider = new IsloSandboxProvider(client, {
      ...defaultProviderConfig,
      scmProvider: "gitlab",
    });

    await provider.createSandbox(baseCreateConfig);

    const env = requireCreateEnv(client);
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
    expect(result.ttydUrl).toBe("https://share.test/7680");
  });

  it("waits for resumed sandboxes to be running before writing tunnel env", async () => {
    const getSandbox = vi
      .fn()
      .mockResolvedValueOnce(sandboxResponse({ status: "paused" }))
      .mockResolvedValueOnce(sandboxResponse({ status: "running" }));
    const client = createMockClient({
      getSandbox,
      resumeSandbox: vi.fn(async () => sandboxResponse({ status: "paused" })),
    });
    const provider = new IsloSandboxProvider(client, defaultProviderConfig);

    const result = await provider.resumeSandbox({
      ...baseResumeConfig,
      codeServerEnabled: true,
      sandboxSettings: { tunnelPorts: [3000] },
    });

    expect(result.success).toBe(true);
    expect(getSandbox).toHaveBeenCalledTimes(2);
    expect(getSandbox.mock.calls[1][1]).toMatchObject({
      timeoutInSeconds: expect.any(Number),
    });
    expect(client.sandboxes.execInSandbox).toHaveBeenCalled();
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

  it("rejects missing code-server password secret before constructing provider", () => {
    expect(() =>
      createIsloProvider({
        ...defaultProviderConfig,
        codeServerPasswordSecret: "",
      })
    ).toThrow("createIsloProvider requires codeServerPasswordSecret");
  });
});
