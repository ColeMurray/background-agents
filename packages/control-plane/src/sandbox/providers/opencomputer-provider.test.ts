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
  OpenComputerNotFoundError,
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
      sandboxAccessPasswordSecret: "secret",
    });

    expect(provider.name).toBe("opencomputer");
    expect(provider.capabilities).toEqual({
      supportsSandboxTimeout: true,
      supportsSnapshots: true,
      supportsRestore: true,
      supportsPersistentResume: true,
      supportsExplicitStop: true,
    });
  });

  it("creates a sandbox from the configured template with runtime environment", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
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
      name: expect.stringMatching(/^openinspect-session-1-[0-9a-f]{8}$/),
      egressAllowlist: ["*"],
    });
    expect(createCall).not.toHaveProperty("timeoutSeconds");
    expect(client.setSandboxTimeout).not.toHaveBeenCalled();
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

  it("returns VNC access across create, restore, and resume without a generic VNC tunnel", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });
    const vncConfig = {
      vncEnabled: true,
      sandboxSettings: { vncPort: 6099, tunnelPorts: [6099, 5173] },
    };

    const created = await provider.createSandbox({ ...baseConfig, ...vncConfig });
    const restored = await provider.restoreFromSnapshot({
      ...baseConfig,
      ...vncConfig,
      snapshotImageId: "checkpoint-session-1",
    });
    const resumed = await provider.resumeSandbox({
      providerObjectId: "oc-sandbox-1",
      sessionId: "session-1",
      sandboxId: "sandbox-acme-repo-1",
      ...vncConfig,
    });

    for (const result of [created, restored, resumed]) {
      expect(result).toMatchObject({
        vncAccess: {
          url: expect.stringContaining("6099"),
          password: expect.any(String),
        },
        tunnelUrls: { "5173": expect.stringContaining("5173") },
      });
      expect(result.tunnelUrls).not.toHaveProperty("6099");
    }
    const createEnv = vi.mocked(client.createSandbox).mock.calls[0][0].env;
    const restoreEnv = vi.mocked(client.forkFromCheckpoint).mock.calls[0][0].env;
    expect(createEnv).toMatchObject({ NOVNC_PORT: "6099", VNC_PASSWORD: expect.any(String) });
    expect(restoreEnv).toMatchObject({ NOVNC_PORT: "6099", VNC_PASSWORD: expect.any(String) });
  });

  it("scrubs user-supplied VNC system env when VNC is disabled", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.createSandbox({
      ...baseConfig,
      userEnvVars: { VNC_PASSWORD: "user-password", NOVNC_PORT: "6099" },
    });

    const env = vi.mocked(client.createSandbox).mock.calls[0][0].env;
    expect(env).not.toHaveProperty("VNC_PASSWORD");
    expect(env).not.toHaveProperty("NOVNC_PORT");
    expect(client.setSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "VNC_PASSWORD" })
    );
  });

  it("rejects sandbox creation before mutation when no template is configured", async () => {
    const client = createMockClient();
    Object.assign(client.config, { template: undefined });
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await expect(provider.createSandbox(baseConfig)).rejects.toThrow("OPENCOMPUTER_TEMPLATE");
    expect(client.createSandbox).not.toHaveBeenCalled();
  });

  it("applies an explicit timeout when creating a sandbox", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.createSandbox({
      ...baseConfig,
      timeoutSeconds: 120,
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.timeoutSeconds).toBe(120);
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("oc-sandbox-1", 120);
  });

  it("serializes repo-less sandboxes without nullable repo env or labels", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.createSandbox({
      ...baseConfig,
      repoOwner: null,
      repoName: null,
      branch: null,
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).toMatchObject({
      REPO_OWNER: "",
      REPO_NAME: "",
    });
    expect(createCall.labels).not.toHaveProperty("openinspect_repo");
    expect(JSON.parse(createCall.env!.SESSION_CONFIG)).toMatchObject({
      repo_owner: null,
      repo_name: null,
      branch: null,
    });
  });

  it("adds provider-level LLM credentials to the runtime environment", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
      llmEnvVars: { ANTHROPIC_API_KEY: "sk-provider" },
    });

    await provider.createSandbox(baseConfig);

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).toHaveProperty("ANTHROPIC_API_KEY", "sk-provider");
  });

  it("keeps repo LLM credentials ahead of provider defaults", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
      llmEnvVars: { ANTHROPIC_API_KEY: "sk-provider" },
    });

    await provider.createSandbox({
      ...baseConfig,
      userEnvVars: { ANTHROPIC_API_KEY: "sk-repo" },
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).toHaveProperty("ANTHROPIC_API_KEY", "sk-repo");
  });

  it("scopes clone secrets to GitLab hosts for GitLab sessions", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "gitlab",
      sandboxAccessPasswordSecret: "secret",
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

  it("maps bitbucket to the Bitbucket clone identity", async () => {
    // OpenComputer historically collapsed bitbucket to the GitHub identity (a
    // pre-Bitbucket-support drift that made bitbucket clones impossible); it
    // now resolves the real Bitbucket identity like every provider.
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "bitbucket",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.createSandbox({
      ...baseConfig,
      userEnvVars: { VCS_CLONE_TOKEN: "bb-token" },
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).toMatchObject({
      VCS_HOST: "bitbucket.org",
      VCS_CLONE_USERNAME: "x-token-auth",
    });
    expect(client.setSecret).toHaveBeenCalledWith({
      storeId: "secret-store-1",
      name: "VCS_CLONE_TOKEN",
      value: "bb-token",
      allowedHosts: ["bitbucket.org", "api.bitbucket.org"],
    });
  });

  it("keeps GITHUB-named secrets scoped to GitHub hosts on non-GitHub providers", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "bitbucket",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.createSandbox({
      ...baseConfig,
      userEnvVars: { GITHUB_TOKEN: "gh-token" },
    });

    expect(client.setSecret).toHaveBeenCalledWith({
      storeId: "secret-store-1",
      name: "GITHUB_TOKEN",
      value: "gh-token",
      allowedHosts: ["github.com", "api.github.com"],
    });
  });

  it("uses the Bitbucket clone identity for image builds", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "bitbucket",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.triggerImageBuild({
      buildId: "build-bb",
      scopeKind: "environment",
      scopeId: "env_flagship",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "main" }],
      callbackUrl: "https://control.example/image-builds/build-complete",
      failureCallbackUrl: "https://control.example/image-builds/build-failed",
      callbackToken: "callback-token",
      buildExecutionTimeoutSeconds: 1800,
      providerSessionTimeoutSeconds: 2400,
      cloneToken: "clone-token",
      userEnvVars: {},
      onProviderSessionCreated: vi.fn(async () => undefined),
      correlation: { trace_id: "trace-1", request_id: "request-1" },
    });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          IMAGE_BUILD_MODE: "true",
          VCS_HOST: "bitbucket.org",
          VCS_CLONE_USERNAME: "x-token-auth",
          VCS_CLONE_TOKEN: "clone-token",
        }),
      })
    );
  });

  it("cleans up a created sandbox when runtime startup fails", async () => {
    const client = createMockClient({
      startRuntime: vi.fn(async () => {
        throw new Error("runtime failed");
      }),
    });
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await expect(provider.createSandbox(baseConfig)).rejects.toThrow(
      "Failed to create OpenComputer sandbox"
    );

    expect(client.deleteSandbox).toHaveBeenCalledWith("oc-sandbox-1");
    expect(client.deleteSecretStore).toHaveBeenCalledWith("secret-store-1");
  });

  it("deletes a build sandbox, ignoring a missing sandbox", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.deleteSandbox("oc-build-1");
    expect(client.deleteSandbox).toHaveBeenCalledWith("oc-build-1", undefined);

    vi.mocked(client.deleteSandbox).mockRejectedValueOnce(new OpenComputerNotFoundError("gone"));
    await expect(provider.deleteSandbox("oc-build-2")).resolves.toBeUndefined();
  });

  it("can request attached secret-store cleanup when deleting a sandbox", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.deleteSandbox("oc-build-1", { deleteSecretStore: true });

    expect(client.deleteSandbox).toHaveBeenCalledWith("oc-build-1", {
      deleteSecretStore: true,
    });
  });

  it("derives a unique secret-store name per sandbox", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.createSandbox({ ...baseConfig, userEnvVars: { ANTHROPIC_API_KEY: "sk-test" } });
    await provider.createSandbox({ ...baseConfig, userEnvVars: { ANTHROPIC_API_KEY: "sk-test" } });

    const names = vi.mocked(client.createSecretStore).mock.calls.map((call) => call[0].name);
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^openinspect-/);
    expect(names[1]).toMatch(/^openinspect-/);
    // Names must be unique so concurrent or sequential same-repo builds never
    // collide on create (which would otherwise risk reaping a live store).
    expect(names[0]).not.toBe(names[1]);
  });

  it("forks from a repo image checkpoint when provided", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    const result = await provider.createSandbox({
      ...baseConfig,
      prebuiltImageId: "checkpoint-repo-1",
      prebuiltImageSha: "abc123",
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
          // Build-mode markers inherited from the build sandbox's checkpoint
          // must be neutralized so the fork boots as a session, not a build.
          IMAGE_BUILD_MODE: "false",
          OI_REPO_IMAGE_BUILD_ID: "",
          OI_REPO_IMAGE_CALLBACK_URL: "",
          OI_REPO_IMAGE_CALLBACK_TOKEN: "",
          VCS_CLONE_TOKEN: "",
        }),
      })
    );
    const forkCall = vi.mocked(client.forkFromCheckpoint).mock.calls[0][0];
    expect(forkCall).not.toHaveProperty("timeoutSeconds");
    expect(client.setSandboxTimeout).not.toHaveBeenCalled();
    expect(client.startRuntime).toHaveBeenCalledWith("oc-fork-1");
  });

  it("keeps explicit session clone tokens when forking from a repo image", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.createSandbox({
      ...baseConfig,
      prebuiltImageId: "checkpoint-repo-1",
      userEnvVars: { VCS_CLONE_TOKEN: "session-token" },
    });

    expect(client.forkFromCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: "checkpoint-repo-1",
        env: expect.objectContaining({
          VCS_CLONE_TOKEN: "session-token",
        }),
      })
    );
  });

  it("restores session snapshots by forking from the checkpoint", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    const result = await provider.restoreFromSnapshot({
      ...baseConfig,
      snapshotImageId: "checkpoint-session-1",
    });

    expect(result).toMatchObject({ success: true, providerObjectId: "oc-fork-1" });
    expect(client.forkFromCheckpoint).toHaveBeenCalledWith(
      expect.objectContaining({
        checkpointId: "checkpoint-session-1",
        env: expect.objectContaining({
          RESTORED_FROM_SNAPSHOT: "true",
          IMAGE_BUILD_MODE: "false",
        }),
      })
    );
    const forkCall = vi.mocked(client.forkFromCheckpoint).mock.calls[0][0];
    expect(forkCall).not.toHaveProperty("timeoutSeconds");
    expect(client.setSandboxTimeout).not.toHaveBeenCalled();
    expect(client.startRuntime).toHaveBeenCalledWith("oc-fork-1");
  });

  it("cleans up a restored sandbox when runtime startup fails", async () => {
    const client = createMockClient({
      startRuntime: vi.fn(async () => {
        throw new Error("runtime failed");
      }),
    });
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await expect(
      provider.restoreFromSnapshot({
        ...baseConfig,
        snapshotImageId: "checkpoint-session-1",
      })
    ).rejects.toThrow("Failed to restore OpenComputer sandbox from checkpoint");

    expect(client.deleteSandbox).toHaveBeenCalledWith("oc-fork-1");
    expect(client.deleteSecretStore).toHaveBeenCalledWith("secret-store-1");
  });

  it("applies an explicit timeout when restoring from a snapshot", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.restoreFromSnapshot({
      ...baseConfig,
      snapshotImageId: "checkpoint-session-1",
      timeoutSeconds: 120,
    });

    const forkCall = vi.mocked(client.forkFromCheckpoint).mock.calls[0][0];
    expect(forkCall.timeoutSeconds).toBe(120);
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("oc-fork-1", 120);
  });

  it("serializes repo-less snapshot restores without nullable repo env or labels", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.restoreFromSnapshot({
      ...baseConfig,
      snapshotImageId: "checkpoint-session-1",
      repoOwner: null,
      repoName: null,
      branch: null,
    });

    const forkCall = vi.mocked(client.forkFromCheckpoint).mock.calls[0][0];
    expect(forkCall.env).toMatchObject({
      REPO_OWNER: "",
      REPO_NAME: "",
    });
    expect(forkCall.labels).not.toHaveProperty("openinspect_repo");
    expect(JSON.parse(forkCall.env!.SESSION_CONFIG)).toMatchObject({
      repo_owner: null,
      repo_name: null,
      branch: null,
    });
  });

  it("never marks a runtime session as an image build", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.createSandbox(baseConfig);

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).toMatchObject({
      IMAGE_BUILD_MODE: "false",
      OI_REPO_IMAGE_PROVIDER_SESSION_ID: "",
      OI_REPO_IMAGE_BUILD_ID: "",
      OI_REPO_IMAGE_CALLBACK_URL: "",
      OI_REPO_IMAGE_CALLBACK_TOKEN: "",
    });
  });

  it("creates checkpoints for snapshots", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
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
      sandboxAccessPasswordSecret: "secret",
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

  it("starts image builds with callback provider session env and reserved-key stripping", async () => {
    const client = createMockClient();
    const onProviderSessionCreated = vi.fn(async () => undefined);
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
      llmEnvVars: { ANTHROPIC_API_KEY: "sk-provider" },
    });

    await provider.triggerImageBuild({
      buildId: "build-1",
      scopeKind: "environment",
      scopeId: "env_flagship",
      repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "main" }],
      callbackUrl: "https://control.example/image-builds/build-complete",
      failureCallbackUrl: "https://control.example/image-builds/build-failed",
      callbackToken: "callback-token",
      buildExecutionTimeoutSeconds: 1800,
      cloneToken: "clone-token",
      userEnvVars: {
        ANTHROPIC_API_KEY: "sk-repo",
        OI_REPO_IMAGE_PROVIDER_SESSION_ID: "user-controlled",
        OI_REPO_IMAGE_CALLBACK_TOKEN: "user-controlled",
        OI_REPO_IMAGE_CALLBACK_SECRET: "legacy-user-controlled",
        OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS: "99999",
      },
      providerSessionTimeoutSeconds: 2400,
      onProviderSessionCreated,
      correlation: { trace_id: "trace-1", request_id: "request-1" },
    });

    expect(client.createSandbox).toHaveBeenCalledWith(
      expect.objectContaining({
        env: expect.objectContaining({
          IMAGE_BUILD_MODE: "true",
          OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS: "1800",
          OI_REPO_IMAGE_BUILD_ID: "build-1",
          OI_REPO_IMAGE_CALLBACK_URL: "https://control.example/image-builds/build-complete",
          OI_REPO_IMAGE_CALLBACK_TOKEN: "callback-token",
          OI_REPO_IMAGE_FAILURE_CALLBACK_URL: "https://control.example/image-builds/build-failed",
          VCS_CLONE_TOKEN: "clone-token",
          ANTHROPIC_API_KEY: "sk-repo",
        }),
        labels: expect.objectContaining({
          openinspect_kind: "environment-image-build",
          openinspect_build_id: "build-1",
        }),
      })
    );
    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    expect(createCall.env).not.toHaveProperty("OI_REPO_IMAGE_PROVIDER_SESSION_ID");
    expect(createCall.env).not.toHaveProperty("OI_REPO_IMAGE_CALLBACK_SECRET");
    expect(client.setSecret).toHaveBeenCalledWith({
      storeId: "secret-store-1",
      name: "ANTHROPIC_API_KEY",
      value: "sk-repo",
      allowedHosts: ["api.anthropic.com"],
    });
    expect(client.setSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "OI_REPO_IMAGE_CALLBACK_TOKEN" })
    );
    expect(client.setSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "OI_REPO_IMAGE_CALLBACK_SECRET" })
    );
    expect(client.setSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: "OI_IMAGE_BUILD_EXECUTION_TIMEOUT_SECONDS" })
    );
    expect(onProviderSessionCreated).toHaveBeenCalledWith("oc-sandbox-1");
    expect(client.startRuntime).toHaveBeenCalledWith("oc-sandbox-1", {
      OI_REPO_IMAGE_PROVIDER_SESSION_ID: "oc-sandbox-1",
    });
  });

  it("starts environment image builds with a repositories-bearing SESSION_CONFIG", async () => {
    const client = createMockClient();
    const onProviderSessionCreated = vi.fn(async () => undefined);
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.triggerImageBuild({
      buildId: "envimg-1",
      scopeKind: "environment",
      scopeId: "env_flagship",
      repositories: [
        { repoOwner: "acme", repoName: "web", baseBranch: "main" },
        { repoOwner: "acme", repoName: "api", baseBranch: "develop" },
      ],
      callbackUrl: "https://control.example/environment-images/build-complete",
      failureCallbackUrl: "https://control.example/environment-images/build-failed",
      callbackToken: "callback-token",
      buildExecutionTimeoutSeconds: 1800,
      providerSessionTimeoutSeconds: 2400,
      cloneToken: "clone-token",
      onProviderSessionCreated,
      correlation: { trace_id: "trace-1", request_id: "request-1" },
    });

    const createCall = vi.mocked(client.createSandbox).mock.calls[0][0];
    // Primary repository mirrors into the scalar identity; the list drives the
    // list-native runtime.
    expect(createCall.env).toMatchObject({
      IMAGE_BUILD_MODE: "true",
      REPO_OWNER: "acme",
      REPO_NAME: "web",
      SANDBOX_ID: "build-env-env_flagship",
      OI_REPO_IMAGE_BUILD_ID: "envimg-1",
      OI_REPO_IMAGE_CALLBACK_URL: "https://control.example/environment-images/build-complete",
      OI_REPO_IMAGE_CALLBACK_TOKEN: "callback-token",
      OI_REPO_IMAGE_FAILURE_CALLBACK_URL: "https://control.example/environment-images/build-failed",
    });
    expect(JSON.parse(createCall.env!.SESSION_CONFIG)).toEqual({
      branch: "main",
      repositories: [
        { repo_owner: "acme", repo_name: "web", branch: "main" },
        { repo_owner: "acme", repo_name: "api", branch: "develop" },
      ],
    });
    expect(createCall.labels).toEqual({
      openinspect_provider: "opencomputer",
      openinspect_framework: "open-inspect",
      openinspect_kind: "environment-image-build",
      openinspect_build_id: "envimg-1",
      openinspect_scope_kind: "environment",
      openinspect_scope_id: "env_flagship",
      openinspect_environment: "env_flagship",
    });
    expect(onProviderSessionCreated).toHaveBeenCalledWith("oc-sandbox-1");
    expect(client.startRuntime).toHaveBeenCalledWith("oc-sandbox-1", {
      OI_REPO_IMAGE_PROVIDER_SESSION_ID: "oc-sandbox-1",
    });
  });

  it("cleans up an image build sandbox when runtime startup fails", async () => {
    const client = createMockClient({
      startRuntime: vi.fn(async () => {
        throw new Error("runtime failed");
      }),
    });
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await expect(
      provider.triggerImageBuild({
        buildId: "build-1",
        scopeKind: "environment",
        scopeId: "env_flagship",
        repositories: [{ repoOwner: "acme", repoName: "repo", baseBranch: "main" }],
        callbackUrl: "https://control.example/image-builds/build-complete",
        failureCallbackUrl: "https://control.example/image-builds/build-failed",
        callbackToken: "callback-token",
        buildExecutionTimeoutSeconds: 1800,
        providerSessionTimeoutSeconds: 2400,
        onProviderSessionCreated: vi.fn(async () => undefined),
        correlation: { trace_id: "trace-1", request_id: "request-1" },
      })
    ).rejects.toThrow("Failed to trigger OpenComputer environment image build");

    expect(client.deleteSandbox).toHaveBeenCalledWith("oc-sandbox-1");
    expect(client.deleteSecretStore).toHaveBeenCalledWith("secret-store-1");
  });

  it("wakes hibernated sandboxes on resume", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
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
    expect(client.setSandboxTimeout).not.toHaveBeenCalled();
    expect(client.startRuntime).toHaveBeenCalledWith("oc-sandbox-1");
  });

  it("applies an explicit timeout when waking a hibernated sandbox", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.resumeSandbox({
      providerObjectId: "oc-sandbox-1",
      sessionId: "session-1",
      sandboxId: "sandbox-acme-repo-1",
      codeServerEnabled: false,
      timeoutSeconds: 120,
    });

    expect(client.wakeSandbox).toHaveBeenCalledWith("oc-sandbox-1");
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("oc-sandbox-1", 120);
    expect(client.startRuntime).toHaveBeenCalledWith("oc-sandbox-1");
  });

  it("renews an explicit timeout when the sandbox is already running", async () => {
    const client = createMockClient({
      getSandbox: vi.fn(async () => ({ id: "oc-sandbox-1", state: "running" })),
    });
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
    });

    await provider.resumeSandbox({
      providerObjectId: "oc-sandbox-1",
      sessionId: "session-1",
      sandboxId: "sandbox-acme-repo-1",
      codeServerEnabled: false,
      timeoutSeconds: 120,
    });

    expect(client.wakeSandbox).not.toHaveBeenCalled();
    expect(client.setSandboxTimeout).toHaveBeenCalledWith("oc-sandbox-1", 120);
    expect(client.startRuntime).not.toHaveBeenCalled();
  });

  it("hibernates sandboxes on stop", async () => {
    const client = createMockClient();
    const provider = new OpenComputerSandboxProvider(client, {
      scmProvider: "github",
      sandboxAccessPasswordSecret: "secret",
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
