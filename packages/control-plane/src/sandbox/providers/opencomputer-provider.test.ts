import { describe, expect, it, vi } from "vitest";
import { OpenComputerSandboxProvider } from "./opencomputer-provider";
import type {
  OpenComputerCreateSandboxParams,
  OpenComputerRestClient,
  OpenComputerSandboxResponse,
} from "../opencomputer-rest-client";
import type { CreateSandboxConfig } from "../provider";

function createMockClient(overrides: Partial<OpenComputerRestClient> = {}): OpenComputerRestClient {
  const client = {
    config: {
      apiUrl: "https://opencomputer.test",
      apiKey: "oc-token",
      template: "openinspect-runtime",
    },
    createSandbox: vi.fn(
      async (params: OpenComputerCreateSandboxParams): Promise<OpenComputerSandboxResponse> => ({
        id: "oc-sandbox-1",
        state: "running",
        routes: [{ port: 3000, url: `https://${params.name}-3000.opencomputer.test` }],
      })
    ),
    getSandbox: vi.fn(async (): Promise<OpenComputerSandboxResponse> => ({
      id: "oc-sandbox-1",
      state: "hibernated",
    })),
    wakeSandbox: vi.fn(async (): Promise<OpenComputerSandboxResponse> => ({
      id: "oc-sandbox-1",
      state: "running",
    })),
    hibernateSandbox: vi.fn(async (): Promise<void> => undefined),
    startRuntime: vi.fn(async (): Promise<void> => undefined),
    createSecretStore: vi.fn(async () => ({
      id: "secret-store-1",
      name: "openinspect-session-1",
      egressAllowlist: [],
    })),
    setSecret: vi.fn(async (): Promise<void> => undefined),
    deleteSecretStore: vi.fn(async (): Promise<void> => undefined),
    getTunnelUrl: vi.fn(async (_id: string, port: number) => ({
      url: `https://oc-sandbox-1-${port}.opencomputer.test`,
    })),
    ...overrides,
  };
  return client as unknown as OpenComputerRestClient;
}

const baseConfig: CreateSandboxConfig = {
  sessionId: "session-1",
  sandboxId: "sandbox-acme-repo-1",
  repoOwner: "acme",
  repoName: "repo",
  controlPlaneUrl: "https://control.example",
  sandboxAuthToken: "sandbox-token",
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  branch: "main",
};

describe("OpenComputerSandboxProvider", () => {
  it("reports persistent hibernate/resume capabilities", () => {
    const provider = new OpenComputerSandboxProvider(createMockClient(), {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    expect(provider.name).toBe("opencomputer");
    expect(provider.capabilities).toEqual({
      supportsSnapshots: false,
      supportsRestore: false,
      supportsWarm: false,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
  });

  it("creates a sandbox from the configured template with runtime environment", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    const result = await provider.createSandbox({
      ...baseConfig,
      userEnvVars: { ANTHROPIC_API_KEY: "sk-test" },
      codeServerEnabled: true,
      sandboxSettings: { codeServerPort: 3000, tunnelPorts: [5173] },
    });

    expect(result).toMatchObject({
      sandboxId: "sandbox-acme-repo-1",
      providerObjectId: "oc-sandbox-1",
      status: "running",
      codeServerUrl: "https://sandbox-acme-repo-1-3000.opencomputer.test",
      tunnelUrls: { "5173": "https://oc-sandbox-1-5173.opencomputer.test" },
    });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "sandbox-acme-repo-1",
        template: "openinspect-runtime",
        env: expect.objectContaining({
          SANDBOX_ID: "sandbox-acme-repo-1",
          CONTROL_PLANE_URL: "https://control.example",
          SANDBOX_AUTH_TOKEN: "sandbox-token",
          REPO_OWNER: "acme",
          REPO_NAME: "repo",
          VCS_HOST: "github.com",
          VCS_CLONE_USERNAME: "x-access-token",
        }),
        labels: expect.objectContaining({
          openinspect_provider: "opencomputer",
          openinspect_session_id: "session-1",
        }),
        secretStore: "openinspect-session-1",
      })
    );

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(client.startRuntime).toHaveBeenCalledWith("oc-sandbox-1");
    expect(createCall.env).toHaveProperty("ANTHROPIC_API_KEY", "sk-test");
    expect(client.createSecretStore).toHaveBeenCalledWith({
      name: "openinspect-session-1",
      egressAllowlist: ["*"],
    });
    expect(client.setSecret).toHaveBeenCalledWith({
      storeId: "secret-store-1",
      name: "ANTHROPIC_API_KEY",
      value: "sk-test",
      allowedHosts: ["api.anthropic.com"],
    });
    expect(JSON.parse(createCall.env!.SESSION_CONFIG)).toMatchObject({
      session_id: "session-1",
      repo_owner: "acme",
      repo_name: "repo",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      branch: "main",
    });
  });

  it("adds provider-level LLM credentials to the runtime environment", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
      llmEnvVars: { ANTHROPIC_API_KEY: "sk-provider" },
    });

    await provider.createSandbox(baseConfig);

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).toHaveProperty("ANTHROPIC_API_KEY", "sk-provider");
  });

  it("wakes hibernated sandboxes on resume", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    const result = await provider.resumeSandbox({
      providerObjectId: "oc-sandbox-1",
      sessionId: "session-1",
      sandboxId: "sandbox-acme-repo-1",
      codeServerEnabled: false,
    });

    expect(result).toMatchObject({ success: true, providerObjectId: "oc-sandbox-1" });
    expect(client.getSandbox).toHaveBeenCalledWith("oc-sandbox-1");
    expect(client.wakeSandbox).toHaveBeenCalledWith("oc-sandbox-1");
    expect(client.startRuntime).toHaveBeenCalledWith("oc-sandbox-1");
  });

  it("hibernates sandboxes on stop", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    await expect(
      provider.stopSandbox({
        providerObjectId: "oc-sandbox-1",
        sessionId: "session-1",
        reason: "inactivity_timeout",
      })
    ).resolves.toEqual({ success: true });

    expect(client.hibernateSandbox).toHaveBeenCalledWith("oc-sandbox-1");
  });
});
