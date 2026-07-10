/**
 * Unit tests for VercelSandboxProvider.
 */

import { describe, expect, it, vi } from "vitest";
import { VercelSandboxProvider, type VercelProviderConfig } from "./provider";
import type { CreateSandboxConfig, RestoreConfig } from "../../provider";
import type {
  VercelCreateSandboxRequest,
  VercelCreateSandboxResponse,
  VercelRunCommandRequest,
  VercelSandboxClient,
  VercelSnapshotMetadata,
  VercelSnapshotResponse,
} from "./client";

function createSessionResponse(
  sessionId = "vercel-session-1",
  routes: VercelCreateSandboxResponse["routes"] = [
    { port: 8080, subdomain: "code", url: "https://code.test" },
    { port: 7680, subdomain: "term", url: "https://term.test" },
    { port: 3000, subdomain: "app", url: "app.test" },
  ]
): VercelCreateSandboxResponse {
  return {
    sandbox: {
      name: "sandbox-456",
      currentSessionId: sessionId,
      createdAt: 123,
      status: "running",
    },
    session: {
      id: sessionId,
      status: "running",
      createdAt: 123,
      cwd: "/workspace",
      timeout: 7200000,
    },
    routes,
  };
}

function createMockClient(
  overrides: Partial<{
    createSandbox: (request: VercelCreateSandboxRequest) => Promise<VercelCreateSandboxResponse>;
    runCommandAndWait: (
      request: VercelRunCommandRequest
    ) => Promise<{ commandId: string; exitCode: number | null }>;
    startCommand: (
      request: VercelRunCommandRequest
    ) => Promise<{ commandId: string; exitCode: number | null }>;
    snapshotSession: (sessionId: string) => Promise<VercelSnapshotResponse>;
    listSnapshots: () => Promise<VercelSnapshotMetadata[]>;
    stopSession: (sessionId: string) => Promise<void>;
    deleteSnapshot: (snapshotId: string) => Promise<void>;
  }> = {}
): VercelSandboxClient {
  return {
    createSandbox: vi.fn(async () => createSessionResponse()),
    runCommandAndWait: vi.fn(async () => ({ commandId: "cmd-1", exitCode: 0 })),
    startCommand: vi.fn(async () => ({ commandId: "cmd-2", exitCode: null })),
    snapshotSession: vi.fn(
      async (): Promise<VercelSnapshotResponse> => ({
        snapshot: { id: "snapshot-1", status: "created", createdAt: 456 },
        session: createSessionResponse().session,
      })
    ),
    listSnapshots: vi.fn(
      async (): Promise<VercelSnapshotMetadata[]> => [
        {
          id: "base-snapshot-from-name",
          sourceSessionId: "session-base",
          status: "created",
          region: "iad1",
          sizeBytes: 1024,
          createdAt: 456,
          updatedAt: 789,
        },
      ]
    ),
    deleteSnapshot: vi.fn(async () => {}),
    stopSession: vi.fn(async () => {}),
    ...overrides,
  } as unknown as VercelSandboxClient;
}

const providerConfig: VercelProviderConfig = {
  scmProvider: "github",
  codeServerPasswordSecret: "code-secret",
  token: "vercel-token",
  teamId: "team-123",
  apiBaseUrl: "https://vercel.test/api",
  baseSnapshotId: "base-snapshot-1",
};

const baseCreateConfig: CreateSandboxConfig = {
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

const baseRestoreConfig: RestoreConfig = {
  snapshotImageId: "snapshot-restore-1",
  sessionId: "session-123",
  sandboxId: "sandbox-456",
  repoOwner: "testowner",
  repoName: "testrepo",
  controlPlaneUrl: "https://control-plane.test",
  sandboxAuthToken: "auth-token",
  provider: "anthropic",
  model: "anthropic/claude-sonnet-4-5",
};

// Mirrors VERCEL_MAX_SANDBOX_TIMEOUT_MS in provider.ts — Vercel rejects timeouts above 45 minutes.
const VERCEL_MAX_SANDBOX_TIMEOUT_MS = 45 * 60 * 1000;

function environmentBuildConfig() {
  return {
    buildId: "envimg-1",
    environmentId: "env_flagship",
    repositories: [{ repoOwner: "acme", repoName: "web", baseBranch: "main" }],
    callbackUrl: "https://control-plane.test/image-builds/build-complete",
    failureCallbackUrl: "https://control-plane.test/image-builds/build-failed",
    callbackToken: "callback-token",
  };
}

describe("VercelSandboxProvider", () => {
  it("reports Vercel capabilities", () => {
    const provider = new VercelSandboxProvider(createMockClient(), providerConfig);

    expect(provider.name).toBe("vercel");
    expect(provider.capabilities).toEqual({
      supportsSnapshots: true,
      supportsRestore: true,
      supportsPersistentResume: false,
      supportsExplicitStop: true,
    });
  });

  it("creates a sandbox from the configured base snapshot and launches the entrypoint", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    const result = await provider.createSandbox({
      ...baseCreateConfig,
      branch: "feature/vercel",
      codeServerEnabled: true,
      sandboxSettings: { terminalEnabled: true },
      userEnvVars: { USER_SECRET: "value", SANDBOX_ID: "user-override" },
      mcpServers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
      agentSlackNotifyEnabled: true,
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall).toEqual(
      expect.objectContaining({
        name: "sandbox-456",
        runtime: "node24",
        sourceSnapshotId: "base-snapshot-1",
        ports: [8080, 7680],
        tags: {
          openinspect_framework: "open-inspect",
          openinspect_session_id: "session-123",
          openinspect_repo: "testowner/testrepo",
          openinspect_expected_sandbox_id: "sandbox-456",
        },
      })
    );
    expect(createCall.env).toEqual(
      expect.objectContaining({
        USER_SECRET: "value",
        SANDBOX_ID: "sandbox-456",
        PATH: expect.stringContaining("/vercel/runtimes/node24/bin"),
        CONTROL_PLANE_URL: "https://control-plane.test",
        SANDBOX_AUTH_TOKEN: "auth-token",
        REPO_OWNER: "testowner",
        REPO_NAME: "testrepo",
        VCS_HOST: "github.com",
        VCS_CLONE_USERNAME: "x-access-token",
        CODE_SERVER_PASSWORD: expect.any(String),
        TERMINAL_ENABLED: "true",
        AGENT_SLACK_NOTIFY_ENABLED: "true",
      })
    );
    expect(JSON.parse(createCall.env?.SESSION_CONFIG as string)).toEqual({
      session_id: "session-123",
      repo_owner: "testowner",
      repo_name: "testrepo",
      provider: "anthropic",
      model: "anthropic/claude-sonnet-4-5",
      mcp_servers: [{ id: "mcp-1", name: "Tool", type: "local", enabled: true }],
      branch: "feature/vercel",
    });
    expect(vi.mocked(client.runCommandAndWait)).not.toHaveBeenCalled();
    expect(vi.mocked(client.startCommand)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "vercel-session-1",
        command: "sudo",
        args: ["-E", "/usr/bin/python3.12", "-m", "sandbox_runtime.entrypoint"],
        cwd: "/workspace",
      }),
      undefined
    );
    expect(result).toEqual(
      expect.objectContaining({
        sandboxId: "sandbox-456",
        providerObjectId: "vercel-session-1",
        status: "warming",
        createdAt: 123,
        codeServerUrl: "https://code.test",
        codeServerPassword: expect.any(String),
        ttydUrl: "https://term.test",
      })
    );
  });

  it("omits repo tag for no-repository sandboxes", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.createSandbox({
      ...baseCreateConfig,
      repoOwner: null,
      repoName: null,
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).toMatchObject({
      REPO_OWNER: "",
      REPO_NAME: "",
    });
    expect(createCall.tags).toEqual({
      openinspect_framework: "open-inspect",
      openinspect_session_id: "session-123",
      openinspect_expected_sandbox_id: "sandbox-456",
    });
  });

  it("caps the default sandbox timeout at Vercel's 45 minute limit", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.createSandbox(baseCreateConfig);

    expect(vi.mocked(client.createSandbox).mock.calls[0][0].timeoutMs).toBe(
      VERCEL_MAX_SANDBOX_TIMEOUT_MS
    );
  });

  it("keeps explicit Vercel sandbox timeouts below the provider limit", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.createSandbox({ ...baseCreateConfig, timeoutSeconds: 30 * 60 });

    expect(vi.mocked(client.createSandbox).mock.calls[0][0].timeoutMs).toBe(30 * 60 * 1000);
  });

  it("caps explicit Vercel sandbox timeouts above the provider limit", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.createSandbox({ ...baseCreateConfig, timeoutSeconds: 60 * 60 });

    expect(vi.mocked(client.createSandbox).mock.calls[0][0].timeoutMs).toBe(
      VERCEL_MAX_SANDBOX_TIMEOUT_MS
    );
  });

  it("caps restore timeouts at Vercel's 45 minute limit", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.restoreFromSnapshot(baseRestoreConfig);

    expect(vi.mocked(client.createSandbox).mock.calls[0][0].timeoutMs).toBe(
      VERCEL_MAX_SANDBOX_TIMEOUT_MS
    );
  });

  it("maps sandbox CPU and memory settings to Vercel vCPU resources", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.createSandbox({
      ...baseCreateConfig,
      sandboxSettings: { cpuCores: 2, memoryMib: 6144 },
    });

    expect(vi.mocked(client.createSandbox).mock.calls[0][0].resources).toEqual({ vcpus: 4 });
  });

  it("omits Vercel resources when sandbox CPU and memory settings use provider defaults", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.createSandbox({
      ...baseCreateConfig,
      sandboxSettings: { cpuCores: null, memoryMib: null },
    });

    expect(vi.mocked(client.createSandbox).mock.calls[0][0].resources).toBeUndefined();
  });

  it("maps restore sandbox memory settings to Vercel vCPU resources", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.restoreFromSnapshot({
      ...baseRestoreConfig,
      sandboxSettings: { memoryMib: 4096 },
    });

    expect(vi.mocked(client.createSandbox).mock.calls[0][0].resources).toEqual({ vcpus: 2 });
  });

  it("rejects Vercel resource requests above the maximum supported vCPU size", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await expect(
      provider.createSandbox({
        ...baseCreateConfig,
        sandboxSettings: { memoryMib: 18432 },
      })
    ).rejects.toMatchObject({
      message: expect.stringContaining("support up to 8 vCPUs; requested 9"),
    });

    expect(vi.mocked(client.createSandbox)).not.toHaveBeenCalled();
  });

  it("resolves a configured base snapshot name before creating a fresh sandbox", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, {
      ...providerConfig,
      baseSnapshotId: undefined,
      baseSnapshotName: "openinspect-base-local-runtime",
    });

    await provider.createSandbox(baseCreateConfig);

    expect(vi.mocked(client.listSnapshots)).toHaveBeenCalledWith(
      {
        name: "openinspect-base-local-runtime",
        limit: 20,
        sortOrder: "desc",
      },
      undefined
    );
    expect(vi.mocked(client.createSandbox).mock.calls[0]?.[0].sourceSnapshotId).toBe(
      "base-snapshot-from-name"
    );
  });

  it("uses a repo image snapshot and writes tunnel URLs for extra exposed ports", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    const result = await provider.createSandbox({
      ...baseCreateConfig,
      prebuiltImageId: "repo-snapshot-1",
      prebuiltImageSha: "abc123",
      codeServerEnabled: true,
      sandboxSettings: { terminalEnabled: true, tunnelPorts: [8080, 3000, 5173] },
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.sourceSnapshotId).toBe("repo-snapshot-1");
    expect(createCall.ports).toEqual([8080, 7680, 3000, 5173]);
    expect(createCall.env).toEqual(
      expect.objectContaining({
        FROM_REPO_IMAGE: "true",
        REPO_IMAGE_SHA: "abc123",
        EXPECTED_TUNNEL_PORTS: "3000,5173",
      })
    );
    expect(vi.mocked(client.runCommandAndWait)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "vercel-session-1",
        command: "sudo",
        args: expect.arrayContaining([
          "/usr/bin/python3.12",
          "-c",
          // Tagged with the logical sandbox ID (first line) so the supervisor's
          // stale-file cleanup keeps this write, then the port URLs.
          expect.stringContaining("TUNNEL_SANDBOX_ID=sandbox-456\\nTUNNEL_3000"),
        ]),
      }),
      undefined
    );
    expect(result.tunnelUrls).toEqual({
      "3000": "https://app.test",
    });
  });

  it("uses configured code-server / terminal ports for exposure and env", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.createSandbox({
      ...baseCreateConfig,
      codeServerEnabled: true,
      sandboxSettings: {
        terminalEnabled: true,
        codeServerPort: 8081,
        terminalPort: 7000,
        tunnelPorts: [8080],
      },
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    // code-server on 8081, terminal on 7000, and the user's 8080 is now a free tunnel.
    expect(createCall.ports).toEqual([8081, 7000, 8080]);
    expect(createCall.env).toEqual(
      expect.objectContaining({
        CODE_SERVER_PORT: "8081",
        TTYD_PROXY_PORT: "7000",
        EXPECTED_TUNNEL_PORTS: "8080",
      })
    );
  });

  it("requires a base snapshot when no repo image snapshot is available", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, {
      ...providerConfig,
      baseSnapshotId: undefined,
    });

    await expect(provider.createSandbox(baseCreateConfig)).rejects.toMatchObject({
      message: expect.stringContaining("VERCEL_BASE_SNAPSHOT_ID or VERCEL_BASE_SNAPSHOT_NAME"),
    });
    expect(vi.mocked(client.createSandbox)).not.toHaveBeenCalled();
  });

  it("uses the configured Vercel runtime when composing PATH", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, {
      ...providerConfig,
      runtime: "node22",
    });

    await provider.createSandbox(baseCreateConfig);

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.runtime).toBe("node22");
    expect(createCall.env?.PATH).toContain("/vercel/runtimes/node22/bin");
    expect(createCall.env?.PATH).not.toContain("/vercel/runtimes/node24/bin");
  });

  it("restores from a session snapshot and sets restore mode env vars", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    const result = await provider.restoreFromSnapshot({
      ...baseRestoreConfig,
      codeServerEnabled: true,
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.sourceSnapshotId).toBe("snapshot-restore-1");
    expect(createCall.env).toEqual(expect.objectContaining({ RESTORED_FROM_SNAPSHOT: "true" }));
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        sandboxId: "sandbox-456",
        providerObjectId: "vercel-session-1",
        codeServerUrl: "https://code.test",
      })
    );
  });

  it("takes and deletes Vercel snapshots", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, {
      ...providerConfig,
      snapshotExpirationMs: 60_000,
    });

    const snapshot = await provider.takeSnapshot({
      providerObjectId: "vercel-session-1",
      sessionId: "session-123",
      reason: "inactivity_timeout",
    });
    await provider.deleteProviderImage("snapshot-1");

    expect(vi.mocked(client.snapshotSession)).toHaveBeenCalledWith(
      "vercel-session-1",
      { expirationMs: 60_000 },
      undefined
    );
    expect(snapshot).toEqual({ success: true, imageId: "snapshot-1" });
    expect(vi.mocked(client.deleteSnapshot)).toHaveBeenCalledWith("snapshot-1");
  });

  it("stops a Vercel sandbox session", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);
    const correlation = {
      trace_id: "trace-1",
      request_id: "request-1",
      session_id: "session-123",
      sandbox_id: "sandbox-456",
    };

    const result = await provider.stopSandbox({
      providerObjectId: "vercel-session-1",
      sessionId: "session-123",
      reason: "inactivity_timeout",
      correlation,
    });

    expect(result).toEqual({ success: true });
    expect(vi.mocked(client.stopSession)).toHaveBeenCalledWith("vercel-session-1", correlation);
  });

  it("reports a failed snapshot status without throwing", async () => {
    const client = createMockClient({
      snapshotSession: vi.fn(
        async (): Promise<VercelSnapshotResponse> => ({
          snapshot: { id: "snapshot-1", status: "failed", createdAt: 456 },
          session: createSessionResponse().session,
        })
      ),
    });
    const provider = new VercelSandboxProvider(client, providerConfig);

    const result = await provider.takeSnapshot({
      providerObjectId: "vercel-session-1",
      sessionId: "session-123",
      reason: "execution_complete",
    });

    expect(result).toEqual({ success: false, error: "Snapshot status was failed" });
  });

  it("keeps reserved callback env keys and clone secrets out of the build sandbox env", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    const result = await provider.triggerEnvironmentImageBuild({
      ...environmentBuildConfig(),
      userEnvVars: {
        USER_SECRET: "value",
        OI_REPO_IMAGE_CALLBACK_TOKEN: "user-controlled",
        OI_REPO_IMAGE_CALLBACK_SECRET: "legacy-user-controlled",
      },
      cloneToken: "clone-token",
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall).toEqual(
      expect.objectContaining({
        runtime: "node24",
        timeoutMs: 1800 * 1000,
        sourceSnapshotId: "base-snapshot-1",
      })
    );
    expect(createCall.env).toEqual(
      expect.objectContaining({
        USER_SECRET: "value",
        IMAGE_BUILD_MODE: "true",
        VCS_CLONE_TOKEN: "clone-token",
      })
    );
    expect(createCall.env).not.toHaveProperty("GITHUB_TOKEN");
    expect(createCall.env).not.toHaveProperty("GITHUB_APP_TOKEN");
    expect(createCall.env).not.toHaveProperty("OI_GITHUB_TOKEN_IS_FALLBACK");
    expect(createCall.env).not.toHaveProperty("OI_INTERNAL_CALLBACK_SECRET");
    expect(createCall.env).not.toHaveProperty("OI_VERCEL_TOKEN");
    expect(createCall.env).not.toHaveProperty("OI_VERCEL_CALLBACK_URL");
    expect(createCall.env).not.toHaveProperty("OI_REPO_IMAGE_CALLBACK_TOKEN");
    expect(createCall.env).not.toHaveProperty("OI_REPO_IMAGE_CALLBACK_SECRET");
    expect(createCall.env).not.toHaveProperty("OI_REPO_IMAGE_CALLBACK_URL");
    expect(vi.mocked(client.startCommand)).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: "vercel-session-1",
        command: "sudo",
        args: ["-E", "/usr/bin/python3.12", "-m", "sandbox_runtime.entrypoint"],
        cwd: "/workspace",
        env: {
          OI_REPO_IMAGE_PROVIDER_SESSION_ID: "vercel-session-1",
          OI_REPO_IMAGE_BUILD_ID: "envimg-1",
          OI_REPO_IMAGE_CALLBACK_URL: "https://control-plane.test/image-builds/build-complete",
          OI_REPO_IMAGE_CALLBACK_TOKEN: "callback-token",
          OI_REPO_IMAGE_FAILURE_CALLBACK_URL:
            "https://control-plane.test/image-builds/build-failed",
        },
      }),
      undefined
    );
    expect(result).toEqual({ buildId: "envimg-1", status: "building" });
  });

  it("starts environment image builds with a repositories-bearing SESSION_CONFIG", async () => {
    const client = createMockClient();
    const onProviderSessionCreated = vi.fn(async () => undefined);
    const provider = new VercelSandboxProvider(client, providerConfig);

    const result = await provider.triggerEnvironmentImageBuild({
      buildId: "envimg-1",
      environmentId: "env_flagship",
      repositories: [
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
      ],
      callbackUrl: "https://control-plane.test/environment-images/build-complete",
      failureCallbackUrl: "https://control-plane.test/environment-images/build-failed",
      callbackToken: "callback-token",
      cloneToken: "clone-token",
      onProviderSessionCreated,
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    // Primary repository mirrors into the scalar identity; the list drives the
    // list-native runtime.
    expect(createCall.env).toEqual(
      expect.objectContaining({
        IMAGE_BUILD_MODE: "true",
        REPO_OWNER: "acme",
        REPO_NAME: "web",
        SANDBOX_ID: "build-env-env_flagship",
        VCS_CLONE_TOKEN: "clone-token",
      })
    );
    expect(JSON.parse(createCall.env?.SESSION_CONFIG as string)).toEqual({
      branch: "main",
      repositories: [
        { repo_owner: "acme", repo_name: "web", branch: "main" },
        { repo_owner: "acme", repo_name: "api", branch: "develop" },
      ],
    });
    expect(createCall.tags).toEqual(
      expect.objectContaining({
        openinspect_kind: "environment-image-build",
        openinspect_environment: "env_flagship",
      })
    );
    expect(onProviderSessionCreated).toHaveBeenCalledWith("vercel-session-1");
    expect(vi.mocked(client.startCommand)).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {
          OI_REPO_IMAGE_PROVIDER_SESSION_ID: "vercel-session-1",
          OI_REPO_IMAGE_BUILD_ID: "envimg-1",
          OI_REPO_IMAGE_CALLBACK_URL:
            "https://control-plane.test/environment-images/build-complete",
          OI_REPO_IMAGE_CALLBACK_TOKEN: "callback-token",
          OI_REPO_IMAGE_FAILURE_CALLBACK_URL:
            "https://control-plane.test/environment-images/build-failed",
        },
      }),
      undefined
    );
    expect(result).toEqual({ buildId: "envimg-1", status: "building" });
  });

  it("honors an explicit build timeout below the Vercel limit for image builds", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.triggerEnvironmentImageBuild({
      ...environmentBuildConfig(),
      buildTimeoutSeconds: 30 * 60,
    });

    expect(vi.mocked(client.createSandbox).mock.calls[0][0].timeoutMs).toBe(30 * 60 * 1000);
  });

  it("caps an over-limit build timeout at Vercel's 45 minute limit", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);

    await provider.triggerEnvironmentImageBuild({
      ...environmentBuildConfig(),
      buildTimeoutSeconds: 60 * 60,
    });

    expect(vi.mocked(client.createSandbox).mock.calls[0][0].timeoutMs).toBe(
      VERCEL_MAX_SANDBOX_TIMEOUT_MS
    );
  });

  it("fails sandbox launch when tunnel env writing exits non-zero", async () => {
    const client = createMockClient({
      runCommandAndWait: vi.fn(async () => ({ commandId: "cmd-1", exitCode: 1 })),
    });
    const provider = new VercelSandboxProvider(client, providerConfig);

    await expect(
      provider.createSandbox({
        ...baseCreateConfig,
        codeServerEnabled: true,
        sandboxSettings: { tunnelPorts: [3000] },
      })
    ).rejects.toThrow("Failed to create Vercel sandbox");
  });

  it("binds the provider session before launching the image build callback entrypoint", async () => {
    const client = createMockClient();
    const provider = new VercelSandboxProvider(client, providerConfig);
    const onProviderSessionCreated = vi.fn(async () => undefined);

    await provider.triggerEnvironmentImageBuild({
      ...environmentBuildConfig(),
      onProviderSessionCreated,
    });

    expect(onProviderSessionCreated).toHaveBeenCalledWith("vercel-session-1");
    expect(onProviderSessionCreated.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(client.startCommand).mock.invocationCallOrder[0]
    );
  });
});
