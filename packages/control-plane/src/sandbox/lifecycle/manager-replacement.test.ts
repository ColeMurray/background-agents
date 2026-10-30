import { describe, it, expect, vi } from "vitest";
import { COMPATIBLE_RUNTIME_VERSION } from "../../image-builds/test-helpers";
import { computeRepositoriesFingerprint } from "../../image-builds/fingerprint";
import {
  PrebuiltImageUnavailableError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
} from "../provider";
import type { ImageBuildLookup } from "./image-selection";
import {
  createMockSession,
  createMockSandbox,
  createMockStorage,
  createMockBroadcaster,
  createMockWebSocketManager,
  createMockAlarmScheduler,
  createMockIdGenerator,
  createMockProvider,
  createTestConfig,
  createTestLifecycleManager,
  createUnmanagedShutdown,
  noLifetime,
} from "./test-helpers";

describe("instance replacement", () => {
  function replacementHarness(
    sandbox: ReturnType<typeof createMockSandbox>,
    options: {
      provider?: ReturnType<typeof createMockProvider>;
      alarmScheduler?: ReturnType<typeof createMockAlarmScheduler>;
      imageBuildLookup?: ImageBuildLookup;
    } = {}
  ) {
    const storage = createMockStorage(
      createMockSession(),
      sandbox,
      undefined,
      options.imageBuildLookup
        ? [{ repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" }]
        : []
    );
    const provider = options.provider ?? createMockProvider();
    const dispatchOpenAtReplacement: boolean[] = [];
    const onInstanceReplaced = vi.fn(async () => {
      storage.calls.push("onInstanceReplaced");
      dispatchOpenAtReplacement.push(manager.mayProcessQueuedWork());
    });
    const manager = createTestLifecycleManager(
      provider,
      storage,
      storage,
      createMockBroadcaster(),
      createMockWebSocketManager(false),
      options.alarmScheduler ?? createMockAlarmScheduler(),
      createMockIdGenerator(),
      createUnmanagedShutdown(),
      { ...createTestConfig(), onInstanceReplaced },
      options.imageBuildLookup
    );
    return { storage, manager, provider, onInstanceReplaced, dispatchOpenAtReplacement };
  }

  it.each([
    ["spawn", { status: "stopped" }],
    [
      "restore",
      {
        status: "stopped",
        snapshot_image_id: "saved-image",
        snapshot_runtime_version: COMPATIBLE_RUNTIME_VERSION,
      },
    ],
  ] as const)("%s reports the replacement once its reservation is published", async (kind, row) => {
    const { storage, manager, provider, onInstanceReplaced } = replacementHarness(
      createMockSandbox(row)
    );

    await manager.spawnSandbox();

    expect(onInstanceReplaced).toHaveBeenCalledOnce();
    expect(storage.calls.indexOf("updateSandboxAuthTokenHash")).toBeLessThan(
      storage.calls.indexOf("onInstanceReplaced")
    );
    expect(
      kind === "spawn" ? provider.createSandbox : provider.restoreFromSnapshot
    ).toHaveBeenCalledOnce();
  });

  it("does not report an in-place resume, which keeps its bridge", async () => {
    const resumeSandbox = vi.fn(async () => ({ success: true as const, lifetime: noLifetime() }));
    const sandbox = createMockSandbox({ status: "stopped" });
    const { manager, onInstanceReplaced } = replacementHarness(sandbox, {
      provider: createMockProvider({
        capabilities: { supportsPersistentResume: true },
        resumeSandbox,
      }),
    });

    await manager.spawnSandbox();

    expect(resumeSandbox).toHaveBeenCalledOnce();
    expect(sandbox.status).toBe("connecting");
    expect(onInstanceReplaced).not.toHaveBeenCalled();
  });

  it("reports a resume that falls back to a fresh spawn", async () => {
    const { manager, provider, onInstanceReplaced } = replacementHarness(
      createMockSandbox({ status: "stopped" }),
      {
        provider: createMockProvider({
          capabilities: { supportsPersistentResume: true },
          resumeSandbox: vi.fn(async () => ({
            success: false as const,
            error: "gone",
            shouldSpawnFresh: true,
          })),
        }),
      }
    );

    await manager.spawnSandbox();

    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(onInstanceReplaced).toHaveBeenCalledOnce();
  });

  it("does not report a superseded reservation", async () => {
    const { storage, manager, provider, onInstanceReplaced } = replacementHarness(
      createMockSandbox({ status: "stopped" })
    );
    vi.mocked(storage.updateSandboxAuthTokenHash).mockReturnValue(false);

    await manager.spawnSandbox();

    expect(onInstanceReplaced).not.toHaveBeenCalled();
    expect(provider.createSandbox).not.toHaveBeenCalled();
  });

  it("does not report a reservation that failed to arm its connect watchdog", async () => {
    const alarmScheduler = createMockAlarmScheduler();
    vi.mocked(alarmScheduler.schedule).mockRejectedValueOnce(new Error("alarm unavailable"));
    const { manager, provider, onInstanceReplaced } = replacementHarness(
      createMockSandbox({ status: "stopped" }),
      { alarmScheduler }
    );

    await manager.spawnSandbox();

    expect(onInstanceReplaced).not.toHaveBeenCalled();
    expect(provider.createSandbox).not.toHaveBeenCalled();
  });

  it("launches the replacement even when settling the replaced instance fails", async () => {
    const sandbox = createMockSandbox({ status: "stopped" });
    const { manager, provider, onInstanceReplaced } = replacementHarness(sandbox);
    onInstanceReplaced.mockRejectedValueOnce(new Error("storage unavailable"));

    await manager.spawnSandbox();

    expect(provider.createSandbox).toHaveBeenCalledOnce();
    expect(sandbox.status).toBe("connecting");
  });

  it("reports the prebuilt-image retry's reservation while dispatch is still closed", async () => {
    const imageBuildLookup: ImageBuildLookup = {
      getLatestReady: vi.fn(async () => ({
        id: "image-build-1",
        provider_image_id: "im-prebuilt",
        repositories_fingerprint: await computeRepositoriesFingerprint([
          { repoOwner: "testowner", repoName: "testrepo", baseBranch: "main" },
        ]),
        repository_shas: JSON.stringify([
          { repoOwner: "testowner", repoName: "testrepo", baseSha: "sha-1" },
        ]),
        runtime_version: COMPATIBLE_RUNTIME_VERSION,
      })),
      markRestoreFailed: vi.fn(async () => true),
    };
    const createSandbox = vi
      .fn<(config: CreateSandboxConfig) => Promise<CreateSandboxResult>>()
      .mockRejectedValueOnce(new PrebuiltImageUnavailableError("prebuilt image gone"))
      .mockImplementation(async (config) => ({
        sandboxId: config.sandboxId,
        providerObjectId: "provider-obj-retry",
        createdAt: Date.now(),
        lifetime: noLifetime(),
      }));
    const { manager, onInstanceReplaced, dispatchOpenAtReplacement } = replacementHarness(
      createMockSandbox({ status: "stopped" }),
      { provider: createMockProvider({ createSandbox }), imageBuildLookup }
    );

    await manager.spawnSandbox();

    expect(createSandbox).toHaveBeenCalledTimes(2);
    expect(createSandbox.mock.calls[1][0]).toMatchObject({ prebuiltImageId: null });
    // One report per reservation. No prompt can be dispatched between them,
    // so the retry's report finds nothing the first one left processing.
    expect(onInstanceReplaced).toHaveBeenCalledTimes(2);
    expect(dispatchOpenAtReplacement).toEqual([false, false]);
  });
});
