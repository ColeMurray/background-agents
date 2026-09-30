import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@open-inspect/shared/types/integrations";
import { hashToken } from "../../auth/crypto";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import type { PendingSandboxAllocation, SessionRepositoryInfo } from "../provider";
import { SandboxLifecycleManager } from "./manager";
import {
  createMockAlarmScheduler,
  createMockBroadcaster,
  createMockIdGenerator,
  createMockProvider,
  createMockSandbox,
  createMockSession,
  createMockStorage,
  createMockWebSocketManager,
  createTestConfig,
  createUnmanagedShutdown,
  noLifetime,
} from "./test-helpers";

vi.mock("../../auth/crypto", () => ({ hashToken: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function createLaunchFixture() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(2_000_000);
  const effects: string[] = [];
  const repositories: SessionRepositoryInfo[] = [
    {
      repoOwner: "group/subgroup",
      repoName: "api",
      baseBranch: "release",
      baseSha: "start-sha",
    },
  ];
  const servers: McpServerConfig[] = [
    {
      id: "mcp-1",
      name: "tools",
      type: "remote",
      enabled: true,
      url: "https://mcp.example",
      headers: { Authorization: "private-mcp" },
    },
  ];
  const session = createMockSession({
    repo_owner: "group/subgroup",
    repo_name: "api",
    base_branch: "release",
    environment_id: "environment-1",
    model: "",
    harness: "claude",
    code_server_enabled: 1,
    vnc_enabled: 1,
    sandbox_settings: '{"sandboxTimeoutMs":3600000,"terminalEnabled":true}',
  });
  const sandbox = createMockSandbox({
    status: "pending",
    modal_object_id: null,
    modal_sandbox_id: "prior-sandbox",
    last_heartbeat: null,
  });
  const storage = createMockStorage(session, sandbox);
  const sessionContext = {
    getSession: () => session,
    getUserEnvVars: vi.fn(async () => {
      effects.push("env");
      return { API_KEY: "private-env" };
    }),
    getSessionRepositories: vi.fn(() => {
      effects.push("repositories");
      return repositories;
    }),
  };
  const imageBuildLookup = {
    getLatestReady: vi.fn(async () => {
      effects.push("image");
      return null;
    }),
    markRestoreFailed: vi.fn(async () => true),
  };
  const mcpServerLookup = {
    getDecryptedForSession: vi.fn(async () => {
      effects.push("mcp");
      return servers;
    }),
  };
  const slackAgentNotifyLookup = {
    isEnabledForRepo: vi.fn(async () => {
      effects.push("slack");
      return true;
    }),
  };
  const shutdown = createUnmanagedShutdown();
  shutdown.reserveStartup.mockImplementation((_createdAt, _policy, persist) => {
    effects.push("reserve");
    persist();
  });
  shutdown.recordPendingProviderHandle.mockImplementation(async () => {
    effects.push("pending_registration");
    return "registered";
  });
  const provider = createMockProvider();
  provider.pendingSandboxAllocation = vi.fn(
    (): PendingSandboxAllocation => ({
      reference: "pending-provider",
      lifetime: {
        kind: "finite",
        observedAtMs: Date.now(),
        expiresAtMs: Date.now() + 3_600_000,
        source: "conservative_start_bound",
      },
    })
  );
  const manager = new SandboxLifecycleManager(
    provider,
    storage,
    sessionContext,
    createMockBroadcaster(),
    createMockWebSocketManager(),
    createMockAlarmScheduler(),
    createMockIdGenerator(),
    shutdown,
    {
      ...createTestConfig(),
      model: "openai/gpt-5.4",
      mcpServerLookup,
      slackAgentNotifyLookup,
    },
    imageBuildLookup
  );
  return {
    manager,
    provider,
    sandbox,
    sessionContext,
    shutdown,
    imageBuildLookup,
    mcpServerLookup,
    slackAgentNotifyLookup,
    effects,
    repositories,
    servers,
  };
}

describe("launch input orchestration", () => {
  afterEach(() => vi.useRealTimers());

  it("fresh launch preserves the exact payload and env/image/MCP/Slack order", async () => {
    const {
      manager,
      provider,
      shutdown,
      imageBuildLookup,
      mcpServerLookup,
      slackAgentNotifyLookup,
      effects,
      repositories,
      servers,
    } = createLaunchFixture();
    vi.mocked(hashToken).mockResolvedValueOnce("new-hash");
    const imageEntered = deferred<void>();
    const image = deferred<null>();
    imageBuildLookup.getLatestReady.mockImplementationOnce(() => {
      effects.push("image");
      imageEntered.resolve();
      return image.promise;
    });
    const mcpEntered = deferred<void>();
    const mcp = deferred<McpServerConfig[]>();
    mcpServerLookup.getDecryptedForSession.mockImplementationOnce(() => {
      effects.push("mcp");
      mcpEntered.resolve();
      return mcp.promise;
    });
    vi.mocked(provider.createSandbox).mockImplementation(async (config) => {
      effects.push("create");
      return { sandboxId: config.sandboxId, createdAt: Date.now(), lifetime: noLifetime() };
    });
    expect(effects).toEqual([]);

    const launching = manager.spawnSandbox();
    await imageEntered.promise;

    expect(effects).toEqual(["reserve", "env", "repositories", "image"]);
    expect(provider.createSandbox).not.toHaveBeenCalled();

    image.resolve(null);
    await mcpEntered.promise;

    expect(effects).toEqual(["reserve", "env", "repositories", "image", "mcp"]);
    expect(slackAgentNotifyLookup.isEnabledForRepo).not.toHaveBeenCalled();
    expect(provider.createSandbox).not.toHaveBeenCalled();

    mcp.resolve(servers);
    await launching;

    expect(vi.mocked(provider.createSandbox).mock.calls).toStrictEqual([
      [
        {
          sessionId: "test-session",
          generationCreatedAtMs: 2_000_000,
          retireSandboxId: "prior-sandbox",
          sandboxId: "sandbox-group/subgroup-api-2000000",
          sandboxAuthToken: "generated-id-1",
          controlPlaneUrl: "https://test.workers.dev",
          repoOwner: "group/subgroup",
          repoName: "api",
          branch: "release",
          harness: "claude",
          provider: "openai",
          model: "gpt-5.4",
          userEnvVars: { API_KEY: "private-env" },
          prebuiltImageId: null,
          prebuiltImageSha: null,
          timeoutSeconds: 3600,
          codeServerEnabled: true,
          vncEnabled: true,
          agentSlackNotifyEnabled: true,
          mcpServers: servers,
          sandboxSettings: { sandboxTimeoutMs: 3_600_000, terminalEnabled: true },
          repositories,
        },
      ],
    ]);
    expect(effects).toEqual([
      "reserve",
      "env",
      "repositories",
      "image",
      "mcp",
      "slack",
      "pending_registration",
      "create",
    ]);
    expect(shutdown.markRecoveryInvoked).not.toHaveBeenCalled();
    expect(provider.restoreFromSnapshot).not.toHaveBeenCalled();
  });

  it("restore preserves the exact payload and env/Slack/MCP order before receipt and provider", async () => {
    const {
      manager,
      provider,
      sandbox,
      shutdown,
      imageBuildLookup,
      slackAgentNotifyLookup,
      effects,
      repositories,
      servers,
    } = createLaunchFixture();
    sandbox.status = "stopped";
    sandbox.snapshot_image_id = "saved-image";
    sandbox.snapshot_runtime_version = COMPATIBLE_RUNTIME_VERSION;
    vi.mocked(hashToken).mockResolvedValueOnce("new-hash");
    const slackEntered = deferred<void>();
    const slack = deferred<boolean>();
    slackAgentNotifyLookup.isEnabledForRepo.mockImplementationOnce(() => {
      effects.push("slack");
      slackEntered.resolve();
      return slack.promise;
    });
    shutdown.markRecoveryInvoked.mockImplementation(() => {
      effects.push("recovery_invoked");
    });
    vi.mocked(provider.restoreFromSnapshot!).mockImplementation(async (config) => {
      effects.push("restore");
      return { success: true, sandboxId: config.sandboxId, lifetime: noLifetime() };
    });
    expect(effects).toEqual([]);

    const launching = manager.spawnSandbox();
    await slackEntered.promise;

    expect(effects).toEqual(["reserve", "env", "repositories", "slack"]);
    expect(provider.restoreFromSnapshot).not.toHaveBeenCalled();
    expect(shutdown.markRecoveryInvoked).not.toHaveBeenCalled();

    slack.resolve(true);
    await launching;

    expect(vi.mocked(provider.restoreFromSnapshot!).mock.calls).toStrictEqual([
      [
        {
          snapshotImageId: "saved-image",
          sessionId: "test-session",
          generationCreatedAtMs: 2_000_000,
          retireSandboxId: "prior-sandbox",
          sandboxId: "sandbox-group/subgroup-api-2000000",
          sandboxAuthToken: "generated-id-1",
          controlPlaneUrl: "https://test.workers.dev",
          repoOwner: "group/subgroup",
          repoName: "api",
          branch: "release",
          harness: "claude",
          provider: "openai",
          model: "gpt-5.4",
          userEnvVars: { API_KEY: "private-env" },
          timeoutSeconds: 3600,
          codeServerEnabled: true,
          vncEnabled: true,
          agentSlackNotifyEnabled: true,
          mcpServers: servers,
          sandboxSettings: { sandboxTimeoutMs: 3_600_000, terminalEnabled: true },
          repositories,
        },
      ],
    ]);
    expect(effects).toEqual([
      "reserve",
      "env",
      "repositories",
      "slack",
      "mcp",
      "pending_registration",
      "recovery_invoked",
      "restore",
    ]);
    expect(imageBuildLookup.getLatestReady).not.toHaveBeenCalled();
    expect(provider.createSandbox).not.toHaveBeenCalled();
  });

  it.each(["fresh", "restore"] as const)(
    "%s reserves the identity before deferred hash and env reads",
    async (mode) => {
      const { manager, provider, sandbox, sessionContext, effects } = createLaunchFixture();
      if (mode === "restore") {
        sandbox.status = "stopped";
        sandbox.snapshot_image_id = "saved-image";
        sandbox.snapshot_runtime_version = COMPATIBLE_RUNTIME_VERSION;
      }
      const hashEntered = deferred<void>();
      const hash = deferred<string>();
      vi.mocked(hashToken).mockImplementationOnce(() => {
        effects.push("hash");
        hashEntered.resolve();
        return hash.promise;
      });
      const envEntered = deferred<void>();
      const env = deferred<{ API_KEY: string }>();
      sessionContext.getUserEnvVars.mockImplementationOnce(() => {
        effects.push("env");
        envEntered.resolve();
        return env.promise;
      });

      const launching = manager.spawnSandbox();
      await hashEntered.promise;

      expect(effects).toEqual(["reserve", "hash"]);
      expect(sandbox.status).toBe("spawning");
      expect(sandbox.created_at).toBe(2_000_000);
      expect(sandbox.modal_sandbox_id).toBe("sandbox-group/subgroup-api-2000000");
      expect(sandbox.auth_token_hash).toBe("");
      expect(sessionContext.getUserEnvVars).not.toHaveBeenCalled();

      hash.resolve("new-hash");
      await envEntered.promise;

      expect(effects).toEqual(["reserve", "hash", "env"]);
      expect(sandbox.auth_token_hash).toBe("new-hash");
      expect(sandbox.runtime_version).toBe(mode === "restore" ? COMPATIBLE_RUNTIME_VERSION : null);
      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(provider.restoreFromSnapshot).not.toHaveBeenCalled();

      env.resolve({ API_KEY: "private-env" });
      await launching;

      expect(
        mode === "fresh" ? provider.createSandbox : provider.restoreFromSnapshot
      ).toHaveBeenCalledOnce();
    }
  );

  it.each(["repo-less", "multi-repo"] as const)(
    "%s fresh launch skips the image await before MCP resolution",
    async (mode) => {
      vi.mocked(hashToken).mockResolvedValueOnce("new-hash");
      const session = createMockSession(
        mode === "repo-less" ? { repo_owner: null, repo_name: null } : {}
      );
      const repositories: SessionRepositoryInfo[] =
        mode === "repo-less"
          ? []
          : [
              { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
              { repoOwner: "group/subgroup", repoName: "api", baseBranch: "release" },
            ];
      const storage = createMockStorage(
        session,
        createMockSandbox({ status: "pending", modal_object_id: null, last_heartbeat: null })
      );
      let repositoryMicrotaskPending = false;
      let mcpStartedBeforeRepositoryMicrotask = false;
      vi.mocked(storage.getSessionRepositories).mockImplementation(() => {
        repositoryMicrotaskPending = true;
        queueMicrotask(() => {
          repositoryMicrotaskPending = false;
        });
        return repositories;
      });
      const manager = new SandboxLifecycleManager(
        createMockProvider(),
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        {
          ...createTestConfig(),
          mcpServerLookup: {
            getDecryptedForSession: async () => {
              mcpStartedBeforeRepositoryMicrotask = repositoryMicrotaskPending;
              return [];
            },
          },
        }
      );

      await manager.spawnSandbox();

      expect(mcpStartedBeforeRepositoryMicrotask).toBe(true);
    }
  );

  it("resume retains its smaller exact payload without env, repositories, integrations, images, or hash work", async () => {
    vi.mocked(hashToken).mockClear();
    const session = createMockSession({ sandbox_settings: '{"sandboxTimeoutMs":3600000}' });
    const sandbox = createMockSandbox({ status: "stopped", snapshot_image_id: null });
    const storage = createMockStorage(session, sandbox);
    const provider = createMockProvider({
      capabilities: { supportsPersistentResume: true },
      resumeSandbox: vi.fn(async () => ({ success: true as const, lifetime: noLifetime() })),
    });
    const mcpServerLookup = { getDecryptedForSession: vi.fn(async () => []) };
    const slackAgentNotifyLookup = { isEnabledForRepo: vi.fn(async () => true) };
    const imageBuildLookup = {
      getLatestReady: vi.fn(async () => null),
      markRestoreFailed: vi.fn(async () => true),
    };
    const manager = new SandboxLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      { ...createTestConfig(), mcpServerLookup, slackAgentNotifyLookup },
      imageBuildLookup
    );

    await manager.spawnSandbox();

    expect(vi.mocked(provider.resumeSandbox!).mock.calls).toStrictEqual([
      [
        {
          providerObjectId: "modal-obj-123",
          sessionId: "test-session",
          sandboxId: "sandbox-testowner-testrepo-123",
          timeoutSeconds: 3600,
          codeServerEnabled: false,
          vncEnabled: false,
          sandboxSettings: { sandboxTimeoutMs: 3_600_000 },
        },
      ],
    ]);
    for (const dependency of [
      hashToken,
      storage.getUserEnvVars,
      storage.getSessionRepositories,
      mcpServerLookup.getDecryptedForSession,
      slackAgentNotifyLookup.isEnabledForRepo,
      imageBuildLookup.getLatestReady,
      imageBuildLookup.markRestoreFailed,
      provider.createSandbox,
      provider.restoreFromSnapshot,
    ]) {
      expect(dependency).not.toHaveBeenCalled();
    }
  });
});
