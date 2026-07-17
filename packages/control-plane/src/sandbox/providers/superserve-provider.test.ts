import { describe, expect, it, vi } from "vitest";
import type { CreateSandboxConfig } from "../provider";
import { SandboxProviderError } from "../provider";
import {
  SuperserveApiError,
  SuperserveNotFoundError,
  type SuperserveRestClient,
} from "../superserve-rest-client";
import { createSuperserveProvider } from "./superserve-provider";

function createClient(overrides: Partial<SuperserveRestClient> = {}): SuperserveRestClient {
  return {
    config: {
      apiUrl: "https://api.superserve.test",
      apiKey: "api-key",
      template: "runtime",
      sandboxHost: "sandbox.superserve.test",
    },
    createSandbox: vi.fn().mockResolvedValue({
      id: "provider-id",
      status: "active",
      access_token: "sandbox-token",
      created_at: "2026-07-17T00:00:00Z",
    }),
    activateSandbox: vi.fn().mockResolvedValue({
      id: "provider-id",
      status: "active",
      access_token: "fresh-token",
    }),
    pauseSandbox: vi.fn().mockResolvedValue(undefined),
    deleteSandbox: vi.fn().mockResolvedValue(undefined),
    startRuntime: vi.fn().mockResolvedValue(undefined),
    getPreviewUrl: vi.fn((id: string, port: number) => `https://${port}-${id}.preview.test`),
    ...overrides,
  } as unknown as SuperserveRestClient;
}

const baseConfig: CreateSandboxConfig = {
  sessionId: "session-id",
  sandboxId: "logical-id",
  repoOwner: "owner/group",
  repoName: "repo",
  controlPlaneUrl: "https://control.test",
  sandboxAuthToken: "control-token",
  provider: "anthropic",
  model: "claude-test",
  branch: "main",
  timeoutSeconds: 7200,
};

describe("SuperserveSandboxProvider", () => {
  it("advertises persistent pause/resume without snapshot support", () => {
    const provider = createSuperserveProvider(createClient(), {
      scmProvider: "github",
      codeServerPasswordSecret: "password-secret",
    });

    expect(provider.name).toBe("superserve");
    expect(provider.capabilities).toEqual({
      supportsSnapshots: false,
      supportsRestore: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
  });

  it("creates the sandbox, prepares previews, and explicitly launches the runtime", async () => {
    const client = createClient();
    const provider = createSuperserveProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "password-secret",
      llmEnvVars: { ANTHROPIC_API_KEY: "provider-key" },
    });

    const result = await provider.createSandbox({
      ...baseConfig,
      userEnvVars: { CUSTOM_SECRET: "custom", ANTHROPIC_API_KEY: "repo-key" },
      codeServerEnabled: true,
      agentSlackNotifyEnabled: true,
      sandboxSettings: {
        terminalEnabled: true,
        codeServerPort: 8080,
        terminalPort: 7680,
        tunnelPorts: [3000, 8080, 7680],
      },
    });

    expect(client.createSandbox).toHaveBeenCalledOnce();
    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall).toMatchObject({
      name: "logical-id",
      timeoutSeconds: 7200,
      metadata: {
        openinspect_framework: "open-inspect",
        openinspect_provider: "superserve",
        openinspect_session_id: "session-id",
        openinspect_expected_sandbox_id: "logical-id",
        openinspect_repo: "owner/group/repo",
      },
    });
    expect(createCall.envVars).toMatchObject({
      ANTHROPIC_API_KEY: "repo-key",
      CUSTOM_SECRET: "custom",
      SANDBOX_ID: "logical-id",
      CONTROL_PLANE_URL: "https://control.test",
      SANDBOX_AUTH_TOKEN: "control-token",
      REPO_OWNER: "owner/group",
      REPO_NAME: "repo",
      CODE_SERVER_PORT: "8080",
      TERMINAL_ENABLED: "true",
      TTYD_PROXY_PORT: "7680",
      EXPECTED_TUNNEL_PORTS: "3000",
      AGENT_SLACK_NOTIFY_ENABLED: "true",
      VCS_HOST: "github.com",
      VCS_CLONE_USERNAME: "x-access-token",
    });
    expect(JSON.parse(createCall.envVars.SESSION_CONFIG)).toMatchObject({
      session_id: "session-id",
      branch: "main",
    });
    expect(client.startRuntime).toHaveBeenCalledWith(
      "provider-id",
      "sandbox-token",
      createCall.envVars,
      { "3000": "https://3000-provider-id.preview.test" }
    );
    expect(result).toMatchObject({
      sandboxId: "logical-id",
      providerObjectId: "provider-id",
      status: "active",
      createdAt: Date.parse("2026-07-17T00:00:00Z"),
      codeServerUrl: "https://8080-provider-id.preview.test",
      ttydUrl: "https://7680-provider-id.preview.test",
      tunnelUrls: { "3000": "https://3000-provider-id.preview.test" },
    });
    expect(result.codeServerPassword).toHaveLength(32);
  });

  it("deletes a partially created sandbox when runtime launch fails", async () => {
    const client = createClient({
      startRuntime: vi.fn().mockRejectedValue(new SuperserveApiError("exec failed", 503)),
    });
    const provider = createSuperserveProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "password-secret",
    });

    await expect(provider.createSandbox(baseConfig)).rejects.toMatchObject({
      name: "SandboxProviderError",
      errorType: "transient",
    });
    expect(client.deleteSandbox).toHaveBeenCalledWith("provider-id");
  });

  it("activates a paused sandbox and ensures the runtime is present", async () => {
    const client = createClient();
    const provider = createSuperserveProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "password-secret",
    });

    const result = await provider.resumeSandbox({
      providerObjectId: "provider-id",
      sessionId: "session-id",
      sandboxId: "logical-id",
      codeServerEnabled: true,
      sandboxSettings: { codeServerPort: 8080, tunnelPorts: [3000] },
    });

    expect(client.activateSandbox).toHaveBeenCalledWith("provider-id");
    expect(client.startRuntime).toHaveBeenCalledWith(
      "provider-id",
      "fresh-token",
      { SANDBOX_ID: "logical-id" },
      { "3000": "https://3000-provider-id.preview.test" }
    );
    expect(result).toMatchObject({
      success: true,
      providerObjectId: "provider-id",
      codeServerUrl: "https://8080-provider-id.preview.test",
      tunnelUrls: { "3000": "https://3000-provider-id.preview.test" },
    });
  });

  it("requests a fresh spawn when the persistent sandbox was deleted", async () => {
    const client = createClient({
      activateSandbox: vi.fn().mockRejectedValue(new SuperserveNotFoundError("gone")),
    });
    const provider = createSuperserveProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "password-secret",
    });

    await expect(
      provider.resumeSandbox({
        providerObjectId: "missing",
        sessionId: "session-id",
        sandboxId: "logical-id",
      })
    ).resolves.toEqual({
      success: false,
      error: "Sandbox no longer exists in Superserve",
      shouldSpawnFresh: true,
    });
  });

  it("treats a missing sandbox as already stopped", async () => {
    const client = createClient({
      pauseSandbox: vi.fn().mockRejectedValue(new SuperserveNotFoundError("gone")),
    });
    const provider = createSuperserveProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "password-secret",
    });

    await expect(
      provider.stopSandbox({
        providerObjectId: "missing",
        sessionId: "session-id",
        reason: "inactivity",
      })
    ).resolves.toEqual({ success: true });
  });

  it("classifies permanent API failures for the lifecycle circuit breaker", async () => {
    const client = createClient({
      pauseSandbox: vi.fn().mockRejectedValue(new SuperserveApiError("unauthorized", 401)),
    });
    const provider = createSuperserveProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "password-secret",
    });

    await expect(
      provider.stopSandbox({
        providerObjectId: "provider-id",
        sessionId: "session-id",
        reason: "inactivity",
      })
    ).rejects.toBeInstanceOf(SandboxProviderError);
  });
});
