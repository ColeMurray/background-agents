import { describe, expect, it, vi } from "vitest";
import { OpenComputerSandboxProvider } from "./opencomputer-provider";
import type {
  OpenComputerCreateSandboxParams,
  OpenComputerForkCheckpointParams,
  OpenComputerRestClient,
  OpenComputerSandboxResponse,
} from "../opencomputer-rest-client";
import {
  OPENCOMPUTER_CHECKPOINT_KIND,
  OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY,
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
    forkFromCheckpoint: vi.fn(
      async (params: OpenComputerForkCheckpointParams): Promise<OpenComputerSandboxResponse> => ({
        id: "oc-fork-1",
        state: "running",
        routes: [{ port: 3000, url: `https://${params.name}-3000.opencomputer.test` }],
      })
    ),
    createCheckpoint: vi.fn(async () => ({
      id: "checkpoint-1",
      sandboxId: "oc-sandbox-1",
      status: "processing",
    })),
    deleteSandbox: vi.fn(async (): Promise<void> => undefined),
    deleteCheckpoint: vi.fn(async (): Promise<void> => undefined),
    getSandbox: vi.fn(
      async (): Promise<OpenComputerSandboxResponse> => ({
        id: "oc-sandbox-1",
        state: "hibernated",
      })
    ),
    wakeSandbox: vi.fn(
      async (): Promise<OpenComputerSandboxResponse> => ({
        id: "oc-sandbox-1",
        state: "running",
      })
    ),
    hibernateSandbox: vi.fn(async (): Promise<void> => undefined),
    setSandboxTimeout: vi.fn(async (): Promise<void> => undefined),
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
  it("reports checkpoint/fork capabilities", () => {
    const provider = new OpenComputerSandboxProvider(createMockClient(), {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    expect(provider.name).toBe("opencomputer");
    expect(provider.capabilities).toEqual({
      supportsSnapshots: true,
      supportsRestore: true,
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
          REPOSITORY_MODE: "single",
          REPO_OWNER: "acme",
          REPO_NAME: "repo",
          VCS_HOST: "github.com",
          VCS_CLONE_USERNAME: "x-access-token",
        }),
        labels: expect.objectContaining({
          openinspect_provider: "opencomputer",
          openinspect_session_id: "session-1",
          openinspect_repo: "acme/repo",
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
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("oc-sandbox-1", 600);
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

  it("normalizes runtime env and labels for no-repository sandboxes", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    await provider.createSandbox({
      ...baseConfig,
      repoOwner: null,
      repoName: null,
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).toEqual(
      expect.objectContaining({
        REPOSITORY_MODE: "none",
        REPO_OWNER: "",
        REPO_NAME: "",
      })
    );
    expect(createCall.labels).toEqual({
      openinspect_framework: "open-inspect",
      openinspect_provider: "opencomputer",
      openinspect_session_id: "session-1",
      openinspect_expected_sandbox_id: "sandbox-acme-repo-1",
    });
    expect(JSON.parse(createCall.env!.SESSION_CONFIG)).toMatchObject({
      repo_owner: null,
      repo_name: null,
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

  it("scopes clone secrets to GitLab hosts for GitLab sessions", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "gitlab",
      codeServerPasswordSecret: "secret",
    });

    await provider.createSandbox({
      ...baseConfig,
      userEnvVars: { VCS_CLONE_TOKEN: "gl-token" },
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).toMatchObject({
      VCS_HOST: "gitlab.com",
      VCS_CLONE_USERNAME: "oauth2",
    });
    expect(client.setSecret).toHaveBeenCalledWith({
      storeId: "secret-store-1",
      name: "VCS_CLONE_TOKEN",
      value: "gl-token",
      allowedHosts: ["gitlab.com", "api.gitlab.com"],
    });
  });

  it("cleans up a created sandbox when runtime startup fails", async () => {
    const client = createMockClient({
      startRuntime: vi.fn(async () => {
        throw new Error("runtime failed");
      }),
    });
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    await expect(provider.createSandbox(baseConfig)).rejects.toThrow(
      "Failed to create OpenComputer sandbox"
    );

    expect(client.deleteSandbox).toHaveBeenCalledWith("oc-sandbox-1");
    expect(client.deleteSecretStore).toHaveBeenCalledWith("secret-store-1");
  });

  it("forks from a repo image checkpoint when provided", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    const result = await provider.createSandbox({
      ...baseConfig,
      repoImageId: "checkpoint-repo-1",
      repoImageSha: "abc123",
    });

    expect(result).toMatchObject({
      providerObjectId: "oc-fork-1",
      status: "running",
    });
    expect(client.createSandbox).not.toHaveBeenCalled();
    expect(client.forkFromCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: "checkpoint-repo-1",
        env: expect.objectContaining({
          FROM_REPO_IMAGE: "true",
          REPO_IMAGE_SHA: "abc123",
        }),
      })
    );
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("oc-fork-1", 600);
    expect(client.startRuntime).toHaveBeenCalledWith("oc-fork-1");
  });

  it("restores session snapshots by forking from the checkpoint", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    const result = await provider.restoreFromSnapshot({
      ...baseConfig,
      snapshotImageId: "checkpoint-session-1",
    });

    expect(result).toMatchObject({ success: true, providerObjectId: "oc-fork-1" });
    expect(client.forkFromCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: "checkpoint-session-1",
        env: expect.objectContaining({ RESTORED_FROM_SNAPSHOT: "true" }),
      })
    );
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("oc-fork-1", 600);
    expect(client.startRuntime).toHaveBeenCalledWith("oc-fork-1");
  });

  it("normalizes runtime env and labels when restoring no-repository sandboxes", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    await provider.restoreFromSnapshot({
      ...baseConfig,
      repoOwner: null,
      repoName: null,
      snapshotImageId: "checkpoint-session-1",
    });

    const forkCall = vi.mocked(client.forkFromCheckpoint).mock.calls[0][0];
    expect(forkCall.env).toEqual(
      expect.objectContaining({
        RESTORED_FROM_SNAPSHOT: "true",
        REPOSITORY_MODE: "none",
        REPO_OWNER: "",
        REPO_NAME: "",
      })
    );
    expect(forkCall.labels).toEqual({
      openinspect_framework: "open-inspect",
      openinspect_provider: "opencomputer",
      openinspect_session_id: "session-1",
      openinspect_expected_sandbox_id: "sandbox-acme-repo-1",
    });
    expect(JSON.parse(forkCall.env!.SESSION_CONFIG)).toMatchObject({
      repo_owner: null,
      repo_name: null,
    });
  });

  it("creates checkpoints for snapshots", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    await expect(
      provider.takeSnapshot({
        providerObjectId: "oc-sandbox-1",
        sessionId: "session-1",
        reason: "user_stop",
      })
    ).resolves.toEqual({ success: true, imageId: "checkpoint-1" });

    expect(client.createCheckpoint).toHaveBeenCalledWith(
      "oc-sandbox-1",
      expect.stringContaining("openinspect-session-1-user_stop-"),
      {
        kind: OPENCOMPUTER_CHECKPOINT_KIND,
        retentionPolicy: OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY,
      }
    );
  });

  it("creates checkpoints for execution-complete snapshots", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
    });

    await expect(
      provider.takeSnapshot({
        providerObjectId: "oc-sandbox-1",
        sessionId: "session-1",
        reason: "execution_complete",
      })
    ).resolves.toEqual({ success: true, imageId: "checkpoint-1" });

    expect(client.createCheckpoint).toHaveBeenCalledWith(
      "oc-sandbox-1",
      expect.stringContaining("openinspect-session-1-execution_complete-"),
      {
        kind: OPENCOMPUTER_CHECKPOINT_KIND,
        retentionPolicy: OPENCOMPUTER_CHECKPOINT_RETENTION_POLICY,
      }
    );
  });

  it("starts repo image builds with callback provider session env", async () => {
    const client = createMockClient();
    const onProviderSessionCreated = vi.fn(async () => undefined);
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      codeServerPasswordSecret: "secret",
      llmEnvVars: { ANTHROPIC_API_KEY: "sk-provider" },
    });

    await provider.triggerRepoImageBuild({
      buildId: "build-1",
      repoOwner: "acme",
      repoName: "repo",
      defaultBranch: "main",
      callbackUrl: "https://control.example/repo-images/build-complete",
      callbackToken: "callback-token",
      onProviderSessionCreated,
    });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          IMAGE_BUILD_MODE: "true",
          OI_REPO_IMAGE_BUILD_ID: "build-1",
          OI_REPO_IMAGE_CALLBACK_URL: "https://control.example/repo-images/build-complete",
          OI_REPO_IMAGE_CALLBACK_TOKEN: "callback-token",
          ANTHROPIC_API_KEY: "sk-provider",
        }),
        labels: expect.objectContaining({
          openinspect_kind: "repo-image-build",
          openinspect_build_id: "build-1",
        }),
      })
    );
    expect(onProviderSessionCreated).toHaveBeenCalledWith("oc-sandbox-1");
    expect(client.startRuntime).toHaveBeenCalledWith("oc-sandbox-1", {
      OI_REPO_IMAGE_PROVIDER_SESSION_ID: "oc-sandbox-1",
    });
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
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("oc-sandbox-1", 600);
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
