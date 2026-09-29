import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServerConfig } from "@open-inspect/shared/types/integrations";
import { hashToken } from "../../auth/crypto";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import type { SessionRepositoryInfo } from "../provider";
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

describe("launch input orchestration", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["fresh", "restore"] as const)(
    "%s keeps reservation before input awaits and the exact provider payload",
    async (mode) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(2_000_000);
      const effects: string[] = [];
      const hashEntered = deferred<void>();
      const hash = deferred<string>();
      vi.mocked(hashToken).mockImplementationOnce(() => {
        effects.push("hash");
        hashEntered.resolve();
        return hash.promise;
      });
      const envEntered = deferred<void>();
      const env = deferred<Record<string, string>>();
      const mcpEntered = deferred<void>();
      const mcp = deferred<McpServerConfig[]>();
      const slackEntered = deferred<void>();
      const slack = deferred<boolean>();
      const repositories: SessionRepositoryInfo[] = [
        {
          repoOwner: "group/subgroup",
          repoName: "api",
          baseBranch: "release",
          baseSha: "start-sha",
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
        status: mode === "fresh" ? "pending" : "stopped",
        modal_object_id: null,
        modal_sandbox_id: "prior-sandbox",
        last_heartbeat: null,
        snapshot_image_id: mode === "restore" ? "saved-image" : null,
        snapshot_runtime_version: mode === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
      });
      const storage = createMockStorage(session, sandbox);
      const sessionContext = {
        getSession: () => session,
        getUserEnvVars: vi.fn(() => {
          effects.push("env");
          envEntered.resolve();
          return env.promise;
        }),
        getSessionRepositories: vi.fn(() => {
          effects.push("repositories");
          return repositories;
        }),
      };
      const image = {
        id: "image-build-1",
        provider_image_id: "prebuilt-image",
        repositories_fingerprint: await computeRepositoriesFingerprint(repositories),
        repository_shas: JSON.stringify([
          { repoOwner: "group/subgroup", repoName: "api", baseSha: "baked-sha" },
        ]),
        runtime_version: COMPATIBLE_RUNTIME_VERSION,
      };
      const imageBuildLookup = {
        getLatestReady: vi.fn(async () => {
          effects.push("image");
          return image;
        }),
        markRestoreFailed: vi.fn(async () => true),
      };
      const shutdown = createUnmanagedShutdown();
      shutdown.reserveStartup.mockImplementation((_createdAt, _policy, persist) => {
        effects.push("reserve");
        persist();
      });
      shutdown.markRecoveryInvoked.mockImplementation(() => {
        effects.push("recovery_invoked");
      });
      const provider = createMockProvider();
      provider.pendingSandboxAllocation = vi.fn(() => {
        effects.push("pending_reference");
        return undefined;
      });
      vi.mocked(provider.createSandbox).mockImplementation(async (config) => {
        effects.push("create");
        return { sandboxId: config.sandboxId, createdAt: Date.now(), lifetime: noLifetime() };
      });
      vi.mocked(provider.restoreFromSnapshot!).mockImplementation(async (config) => {
        effects.push("restore");
        return { success: true, sandboxId: config.sandboxId, lifetime: noLifetime() };
      });
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
          mcpServerLookup: {
            getDecryptedForSession: vi.fn(() => {
              effects.push("mcp");
              mcpEntered.resolve();
              return mcp.promise;
            }),
          },
          slackAgentNotifyLookup: {
            isEnabledForRepo: vi.fn(() => {
              effects.push("slack");
              slackEntered.resolve();
              return slack.promise;
            }),
          },
        },
        imageBuildLookup
      );
      expect(effects).toEqual([]);
      const launching = manager.spawnSandbox();
      await hashEntered.promise;
      expect(effects).toEqual(["reserve", "hash"]);
      expect(sandbox.auth_token_hash).toBe("");
      expect(sandbox.modal_sandbox_id).toBe("sandbox-group/subgroup-api-2000000");
      hash.resolve("new-hash");
      await envEntered.promise;
      expect(effects).toEqual(["reserve", "hash", "env"]);
      if (mode === "restore") expect(sandbox.runtime_version).toBe(COMPATIBLE_RUNTIME_VERSION);
      env.resolve({ API_KEY: "private-env" });
      if (mode === "restore") {
        await slackEntered.promise;
        expect(effects).toEqual(["reserve", "hash", "env", "repositories", "slack"]);
        slack.resolve(true);
      }
      await mcpEntered.promise;
      expect(effects).toEqual(
        mode === "fresh"
          ? ["reserve", "hash", "env", "repositories", "image", "mcp"]
          : ["reserve", "hash", "env", "repositories", "slack", "mcp"]
      );
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
      mcp.resolve(servers);
      if (mode === "fresh") {
        await slackEntered.promise;
        slack.resolve(true);
      }
      await launching;
      const payload = {
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
      };
      if (mode === "fresh") {
        expect(vi.mocked(provider.createSandbox).mock.calls).toStrictEqual([
          [
            {
              ...payload,
              prebuiltImageId: "prebuilt-image",
              prebuiltImageSha: "baked-sha",
            },
          ],
        ]);
        expect(effects).toEqual([
          "reserve",
          "hash",
          "env",
          "repositories",
          "image",
          "mcp",
          "slack",
          "pending_reference",
          "create",
        ]);
        expect(shutdown.markRecoveryInvoked).not.toHaveBeenCalled();
      } else {
        expect(vi.mocked(provider.restoreFromSnapshot!).mock.calls).toStrictEqual([
          [
            {
              ...payload,
              snapshotImageId: "saved-image",
            },
          ],
        ]);
        expect(effects).toEqual([
          "reserve",
          "hash",
          "env",
          "repositories",
          "slack",
          "mcp",
          "pending_reference",
          "recovery_invoked",
          "restore",
        ]);
        expect(imageBuildLookup.getLatestReady).not.toHaveBeenCalled();
        expect(provider.createSandbox).not.toHaveBeenCalled();
      }
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
      const effects: string[] = [];
      vi.mocked(storage.getSessionRepositories).mockImplementation(() => {
        effects.push("repositories");
        queueMicrotask(() => effects.push("next_microtask"));
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
              effects.push("mcp");
              return [];
            },
          },
        }
      );

      await manager.spawnSandbox();

      expect(effects).toEqual(["repositories", "mcp", "next_microtask"]);
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
