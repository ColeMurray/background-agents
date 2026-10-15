import { describe, expect, it, vi } from "vitest";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { buildSessionConfig } from "../sandbox-env";
import {
  createMockSession,
  createMockSandbox,
  createMockStorage,
  createMockProvider,
  createTestLifecycleManager,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createUnmanagedShutdown,
  createTestConfig,
} from "./test-helpers";

describe("Workspace plugins launch contract", () => {
  it.each(["fresh", "restore"] as const)(
    "resolves the current catalog on %s boot and serializes it",
    async (kind) => {
      const storage = createMockStorage(
        createMockSession(),
        createMockSandbox({
          status: kind === "fresh" ? "pending" : "stopped",
          snapshot_image_id: kind === "restore" ? "image-1" : null,
          snapshot_runtime_version: kind === "restore" ? COMPATIBLE_RUNTIME_VERSION : null,
        })
      );
      const provider = createMockProvider();
      const forSession = vi.fn().mockResolvedValue(["@company/audit@1.2.3"]);
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        {
          ...createTestConfig(),
          opencodePluginLookup: { forSession },
        }
      );
      await manager.spawnSandbox();
      const launch =
        kind === "fresh"
          ? vi.mocked(provider.createSandbox).mock.calls[0][0]
          : vi.mocked(provider.restoreFromSnapshot!).mock.calls[0][0];
      expect(forSession).toHaveBeenCalledWith(storage.getSessionRepositories());
      expect(launch.opencodePlugins).toEqual(["@company/audit@1.2.3"]);
      expect(buildSessionConfig(launch).opencode_plugins).toEqual(["@company/audit@1.2.3"]);
    }
  );

  it.each(["claude", "codex"] as const)(
    "does not look up plugins for %s sessions",
    async (harness) => {
      const storage = createMockStorage(
        createMockSession({ harness }),
        createMockSandbox({ status: "pending" })
      );
      const provider = createMockProvider();
      const forSession = vi.fn();
      const manager = createTestLifecycleManager(
        provider,
        storage,
        storage,
        createMockBroadcaster(),
        createMockWebSocketManager(false),
        createMockAlarmScheduler(),
        createMockIdGenerator(),
        createUnmanagedShutdown(),
        {
          ...createTestConfig(),
          opencodePluginLookup: { forSession },
        }
      );
      await manager.spawnSandbox();
      expect(forSession).not.toHaveBeenCalled();
      expect(vi.mocked(provider.createSandbox).mock.calls[0][0].opencodePlugins).toBeUndefined();
    }
  );
});

it.each([false, true])(
  "preserves an old compatible snapshot when plugins are required (durable=%s)",
  async (durable) => {
    const storage = createMockStorage(
      createMockSession(),
      createMockSandbox({
        status: "stopped",
        snapshot_image_id: "saved",
        snapshot_runtime_version: "v76-child-output-discovery",
      })
    );
    const provider = createMockProvider();
    const shutdown = createUnmanagedShutdown();
    if (durable)
      shutdown.startupDecision.mockReturnValue({
        kind: "restore_snapshot",
        snapshotId: "saved",
        runtimeVersion: "v76-child-output-discovery",
      });
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      shutdown,
      {
        ...createTestConfig(),
        opencodePluginLookup: { forSession: vi.fn().mockResolvedValue(["audit@1.0.0"]) },
      }
    );
    await manager.spawnSandbox();
    expect(shutdown.holdFailedRecovery).toHaveBeenCalledWith(
      expect.stringContaining("does not support workspace OpenCode plugins")
    );
    expect(provider.restoreFromSnapshot).not.toHaveBeenCalled();
    expect(provider.createSandbox).not.toHaveBeenCalled();
    expect(storage.updateSandboxRuntimeVersion).not.toHaveBeenCalled();
    expect(storage.getSandbox()?.snapshot_image_id).toBe("saved");
  }
);

it("keeps old compatible snapshots usable without a matching plugin selection", async () => {
  const storage = createMockStorage(
    createMockSession(),
    createMockSandbox({
      status: "stopped",
      snapshot_image_id: "saved",
      snapshot_runtime_version: "v76-child-output-discovery",
    })
  );
  const provider = createMockProvider();
  const manager = createTestLifecycleManager(
    provider,
    storage,
    storage,
    createMockBroadcaster(),
    createMockWebSocketManager(false),
    createMockAlarmScheduler(),
    createMockIdGenerator(),
    createUnmanagedShutdown(),
    { ...createTestConfig(), opencodePluginLookup: { forSession: vi.fn().mockResolvedValue([]) } }
  );
  await manager.spawnSandbox();
  expect(provider.restoreFromSnapshot).toHaveBeenCalledOnce();
});

it.each([
  ["v76-child-output-discovery", ["audit@1.0.0"], null],
  ["v76-child-output-discovery", [], "prebuilt"],
  [COMPATIBLE_RUNTIME_VERSION, ["audit@1.0.0"], "prebuilt"],
] as const)(
  "selects image %s only when its runtime supports the selection",
  async (version, plugins, expectedImageId) => {
    const storage = createMockStorage(
      createMockSession(),
      createMockSandbox({ status: "pending" })
    );
    vi.mocked(storage.getSessionRepositories).mockReturnValue([
      { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main", baseSha: null },
    ]);
    const provider = createMockProvider();
    const imageLookup = {
      getLatestReady: vi.fn().mockResolvedValue({
        id: "build",
        provider_image_id: "prebuilt",
        runtime_version: version,
        repository_shas: "[]",
        repositories_fingerprint: await computeRepositoriesFingerprint(
          storage.getSessionRepositories()
        ),
      }),
      markRestoreFailed: vi.fn(),
    };
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      {
        ...createTestConfig(),
        opencodePluginLookup: { forSession: vi.fn().mockResolvedValue([...plugins]) },
      },
      imageLookup
    );
    await manager.spawnSandbox();
    expect(vi.mocked(provider.createSandbox).mock.calls[0][0].prebuiltImageId).toBe(
      expectedImageId
    );
  }
);
