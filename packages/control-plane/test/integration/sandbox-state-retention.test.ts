import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SandboxProvider, SnapshotResult, RestoreResult } from "../../src/sandbox/provider";
import { SandboxShutdownRepository } from "../../src/session/sandbox-shutdown-repository";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, queryDO, seedSandboxAuth, seedMessage } from "./helpers";
import { runInSessionDO } from "./session-do-access";
import { realLifecycleHarness } from "./sandbox-lifecycle-harness";

const AUTH_TOKEN = "state-retention-token";
const SANDBOX_ID = "state-retention-sandbox";
beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

async function servingSession() {
  const { stub } = await initNamedSession(`state-retention-${crypto.randomUUID()}`);
  await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
  await queryDO(stub, "DELETE FROM sandbox_preservation");
  await queryDO(
    stub,
    "UPDATE sandbox SET modal_object_id = 'legacy-source', runtime_version = 'v67-legacy'"
  );
  return stub;
}

function snapshotProvider(overrides: Partial<SandboxProvider> = {}): SandboxProvider {
  return {
    name: "modal",
    capabilities: {
      supportsSandboxTimeout: true,
      supportsSnapshots: true,
      supportsExplicitStop: true,
      supportsRestore: true,
    },
    createSandbox: vi.fn(async () => {
      throw new Error("must not replace without explicit recovery");
    }),
    takeSnapshot: vi.fn(async () => ({ success: true, imageId: "rescued-filesystem" })),
    stopSandbox: vi.fn(async () => ({ success: true })),
    ...overrides,
  };
}

describe("sandbox state retention", () => {
  it("does not mark a serving source replaceable when its retirement fence cannot commit", async () => {
    const stub = await servingSession();
    await runInSessionDO(stub, async (instance, durableState) => {
      durableState.storage.sql.exec(
        "CREATE TRIGGER reject_retirement BEFORE INSERT ON sandbox_preservation BEGIN SELECT RAISE(FAIL, 'retirement fence unavailable'); END"
      );
      const provider = snapshotProvider();
      const { manager, sandbox } = realLifecycleHarness(instance, durableState, provider);
      expect(await manager.terminateFailedSandbox("runtime crashed")).toBe(false);
      expect(sandbox.getSandbox()?.status).toBe("ready");
      expect(sandbox.getSandbox()?.modal_object_id).toBe("legacy-source");
      expect(provider.takeSnapshot).not.toHaveBeenCalled();
      expect(provider.stopSandbox).not.toHaveBeenCalled();
      expect(provider.createSandbox).not.toHaveBeenCalled();
    });
  });

  it("ignores a capture response belonging to a superseded generation", async () => {
    const stub = await servingSession();
    await runInSessionDO(stub, async (instance, durableState) => {
      let resolveCapture!: (result: SnapshotResult) => void;
      const provider = snapshotProvider({
        takeSnapshot: vi.fn(
          () =>
            new Promise<SnapshotResult>((resolve) => {
              resolveCapture = resolve;
            })
        ),
      });
      const { manager, sandbox } = realLifecycleHarness(instance, durableState, provider);
      const termination = manager.terminateFailedSandbox("runtime crashed");
      await vi.waitFor(() => expect(provider.takeSnapshot).toHaveBeenCalledOnce());
      durableState.storage.sql.exec(
        "UPDATE sandbox SET modal_sandbox_id = 'replacement-generation', modal_object_id = 'replacement-source', created_at = created_at + 1, snapshot_image_id = 'replacement-snapshot'"
      );
      resolveCapture({ success: true, imageId: "late-old-snapshot" });
      await termination;
      expect(sandbox.getSandbox()?.snapshot_image_id).toBe("replacement-snapshot");
      expect(sandbox.getSandbox()?.modal_object_id).toBe("replacement-source");
      expect(provider.stopSandbox).not.toHaveBeenCalled();
    });
  });

  it("keeps an interrupted legacy restore held even when its success arrives after reconstruction", async () => {
    const stub = await servingSession();
    await queryDO(
      stub,
      "UPDATE sandbox SET status = 'stopped', modal_object_id = NULL, snapshot_image_id = 'legacy-snapshot', snapshot_runtime_version = 'v67-legacy'"
    );
    await runInSessionDO(stub, async (instance, durableState) => {
      let resolveRestore!: (result: RestoreResult) => void;
      const provider = snapshotProvider({
        restoreFromSnapshot: vi.fn(
          () =>
            new Promise<RestoreResult>((resolve) => {
              resolveRestore = resolve;
            })
        ),
      });
      const initial = realLifecycleHarness(instance, durableState, provider);
      const restoring = initial.manager.spawnSandbox();
      await vi.waitFor(() => expect(provider.restoreFromSnapshot).toHaveBeenCalledOnce());
      const restarted = realLifecycleHarness(instance, durableState, provider);
      await restarted.manager.spawnSandbox();
      expect(restarted.manager.shutdownSnapshot()).toMatchObject({ phase: "unknown" });
      resolveRestore({
        success: true,
        sandboxId: initial.sandbox.getSandbox()!.modal_sandbox_id!,
        providerObjectId: "late-restored-source",
        lifetime: { kind: "none", observedAtMs: Date.now() },
      });
      await restoring;
      expect(restarted.manager.shutdownSnapshot()).toMatchObject({ phase: "unknown" });
      expect(restarted.manager.mayProcessQueuedWork()).toBe(false);
      await restarted.manager.spawnSandbox();
      expect(provider.restoreFromSnapshot).toHaveBeenCalledOnce();
      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(restarted.sandbox.getSandbox()?.snapshot_image_id).toBe("legacy-snapshot");
    });
  });

  it("terminalizes the interrupted prompt once and keeps pending work paused until explicit recovery", async () => {
    const stub = await servingSession();
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "interrupted",
      authorId,
      content: "partially executed work",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 1_000,
      startedAt: Date.now(),
    });
    await seedMessage(stub, {
      id: "queued",
      authorId,
      content: "later work",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });
    await runInSessionDO(stub, async (instance, durableState) => {
      const provider = snapshotProvider({
        restoreFromSnapshot: vi.fn<NonNullable<SandboxProvider["restoreFromSnapshot"]>>(
          async (config) => ({
            success: true,
            sandboxId: config.sandboxId,
            providerObjectId: "explicitly-restored-source",
            lifetime: { kind: "none", observedAtMs: Date.now() },
          })
        ),
      });
      const initial = realLifecycleHarness(instance, durableState, provider);
      await initial.manager.terminateFailedSandbox("runtime crashed");
      const restarted = realLifecycleHarness(instance, durableState, provider);
      await restarted.manager.handleShutdownAlarm();
      await restarted.manager.spawnSandbox();
      expect(restarted.manager.mayProcessQueuedWork()).toBe(false);
      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(restarted.manager.shutdownSnapshot()).toMatchObject({
        availableRecoveryActions: ["restore_saved"],
      });
      await restarted.manager.recoverShutdown("restore_saved");
      expect(restarted.manager.mayProcessQueuedWork()).toBe(true);
      await restarted.manager.spawnSandbox();
      expect(provider.restoreFromSnapshot).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ snapshotImageId: "rescued-filesystem" })
      );
      expect(restarted.manager.shutdownSnapshot()).toMatchObject({ phase: "running" });
      expect(restarted.sandbox.getSandbox()?.modal_object_id).toBe("explicitly-restored-source");
      expect(provider.createSandbox).not.toHaveBeenCalled();
    });
    expect(
      await queryDO(
        stub,
        "SELECT id, status FROM messages WHERE id IN ('interrupted', 'queued') ORDER BY id"
      )
    ).toEqual([
      { id: "interrupted", status: "failed" },
      { id: "queued", status: "pending" },
    ]);
    expect(
      await queryDO(
        stub,
        "SELECT COUNT(*) AS count FROM events WHERE type = 'execution_complete' AND message_id = 'interrupted'"
      )
    ).toEqual([{ count: 1 }]);
  });

  it("continues replacement when persistence of the continuity warning fails", async () => {
    const stub = await servingSession();
    await queryDO(stub, "UPDATE sandbox SET status = 'stopped', last_heartbeat = ?", Date.now());
    await runInSessionDO(stub, async (instance, durableState) => {
      durableState.storage.sql.exec(
        "CREATE TRIGGER reject_warning BEFORE INSERT ON events WHEN NEW.type = 'warning' BEGIN SELECT RAISE(FAIL, 'warning persistence unavailable'); END"
      );
      const provider = snapshotProvider();
      await realLifecycleHarness(instance, durableState, provider).manager.spawnSandbox();
      expect(provider.createSandbox).toHaveBeenCalledOnce();
    });
  });

  it.each([
    [
      "throws",
      async () => {
        throw new Error("capture response lost");
      },
    ],
    ["reports failure", async () => ({ success: false, error: "unconfirmed" })],
    ["omits its artifact", async () => ({ success: true })],
  ] satisfies Array<[string, NonNullable<SandboxProvider["takeSnapshot"]>]>)(
    "does not destroy when capture %s",
    async (_label, takeSnapshot) => {
      const stub = await servingSession();
      await queryDO(
        stub,
        "UPDATE sandbox SET snapshot_image_id = 'previous-snapshot', snapshot_runtime_version = 'v67-legacy'"
      );
      await runInSessionDO(stub, async (instance, durableState) => {
        const provider = snapshotProvider({ takeSnapshot });
        const { manager, sandbox } = realLifecycleHarness(instance, durableState, provider);
        await manager.terminateFailedSandbox("runtime crashed");
        expect(manager.shutdownSnapshot()).toMatchObject({ phase: "unknown" });
        expect(sandbox.getSandbox()?.snapshot_image_id).toBe("previous-snapshot");
        const restarted = realLifecycleHarness(instance, durableState, provider);
        await restarted.manager.handleShutdownAlarm();
        await restarted.manager.spawnSandbox();
        expect(provider.stopSandbox).not.toHaveBeenCalled();
        expect(provider.createSandbox).not.toHaveBeenCalled();
      });
    }
  );

  it("retains the committed snapshot when source retirement is unconfirmed", async () => {
    const stub = await servingSession();
    await runInSessionDO(stub, async (instance, durableState) => {
      const provider = snapshotProvider({
        stopSandbox: vi.fn(async () => ({ success: false, error: "stop response lost" })),
      });
      const { manager, sandbox } = realLifecycleHarness(instance, durableState, provider);
      await manager.terminateFailedSandbox("runtime crashed");
      expect(manager.shutdownSnapshot()).toMatchObject({
        phase: "unknown",
        hasRecoveryPoint: true,
      });
      expect(sandbox.getSandbox()?.snapshot_image_id).toBe("rescued-filesystem");
      const restarted = realLifecycleHarness(instance, durableState, provider);
      await restarted.manager.handleShutdownAlarm();
      await restarted.manager.spawnSandbox();
      expect(provider.stopSandbox).toHaveBeenCalledOnce();
      expect(provider.createSandbox).not.toHaveBeenCalled();
    });
  });

  it("preserve-stops a persistent provider instead of destroying its only recovery copy", async () => {
    const stub = await servingSession();
    await runInSessionDO(stub, async (instance, durableState) => {
      const provider = snapshotProvider({
        name: "e2b",
        capabilities: {
          supportsSandboxTimeout: true,
          supportsSnapshots: false,
          supportsRestore: false,
          supportsPersistentResume: true,
          supportsExplicitStop: true,
        },
        takeSnapshot: undefined,
        stopSandbox: vi.fn(async (config) => {
          expect(config.intent).toBe("preserve");
          return { success: true };
        }),
      });
      const { manager } = realLifecycleHarness(instance, durableState, provider);
      await manager.terminateFailedSandbox("runtime crashed");
      expect(manager.shutdownSnapshot()).toMatchObject({
        phase: "saved",
        hasRecoveryPoint: true,
        continuationPaused: true,
      });
      expect(provider.stopSandbox).toHaveBeenCalledOnce();
    });
  });

  it("records lost continuity on the timeline even if replacement creation fails", async () => {
    const stub = await servingSession();
    await queryDO(stub, "UPDATE sandbox SET status = 'stopped', last_heartbeat = ?", Date.now());
    await runInSessionDO(stub, async (instance, durableState) => {
      const provider = snapshotProvider();
      const { manager } = realLifecycleHarness(instance, durableState, provider);
      await manager.spawnSandbox();
      expect(provider.createSandbox).toHaveBeenCalledOnce();
    });
    const warnings = await queryDO<{ data: string }>(
      stub,
      "SELECT data FROM events WHERE type = 'warning'"
    );
    expect(warnings.map(({ data }) => JSON.parse(data).message)).toEqual([
      expect.stringContaining("Uncommitted changes and earlier conversation context"),
    ]);
  });

  it("keeps a lost capture held after reconstruction and ignores its late response", async () => {
    const stub = await servingSession();
    await queryDO(
      stub,
      "UPDATE sandbox SET snapshot_image_id = 'previous-snapshot', snapshot_runtime_version = 'v67-legacy'"
    );
    await runInSessionDO(stub, async (instance, durableState) => {
      let resolveCapture!: (result: { success: boolean; imageId: string }) => void;
      const provider = snapshotProvider({
        takeSnapshot: vi.fn(
          () =>
            new Promise<SnapshotResult>((resolve) => {
              resolveCapture = resolve;
            })
        ),
      });
      const initial = realLifecycleHarness(instance, durableState, provider);
      const termination = initial.manager.terminateUnresponsiveSandbox(
        "prompt_dispatch_send_failed"
      );
      await vi.waitFor(() => expect(provider.takeSnapshot).toHaveBeenCalledOnce());
      const restarted = realLifecycleHarness(instance, durableState, provider);
      await restarted.manager.handleShutdownAlarm();
      await restarted.manager.spawnSandbox();
      expect(restarted.manager.shutdownSnapshot()).toMatchObject({ phase: "unknown" });
      resolveCapture({ success: true, imageId: "late-snapshot" });
      await termination;
      expect(restarted.manager.shutdownSnapshot()).toMatchObject({ phase: "unknown" });
      expect(restarted.sandbox.getSandbox()?.snapshot_image_id).toBe("previous-snapshot");
      expect(provider.stopSandbox).not.toHaveBeenCalled();
      expect(provider.createSandbox).not.toHaveBeenCalled();
    });
  });

  it("holds an ambiguous legacy snapshot restore across restart instead of invoking it again", async () => {
    const stub = await servingSession();
    await queryDO(
      stub,
      "UPDATE sandbox SET status = 'stopped', modal_object_id = NULL, snapshot_image_id = 'legacy-snapshot', snapshot_runtime_version = 'v67-legacy'"
    );
    await runInSessionDO(stub, async (instance, durableState) => {
      const provider = snapshotProvider({
        restoreFromSnapshot: vi.fn(async () => {
          throw new Error("restore response lost");
        }),
      });
      const { manager } = realLifecycleHarness(instance, durableState, provider);
      await manager.spawnSandbox();
      expect(manager.shutdownSnapshot()).toMatchObject({ phase: "unknown" });
      const restarted = realLifecycleHarness(instance, durableState, provider);
      await restarted.manager.spawnSandbox();
      expect(provider.restoreFromSnapshot).toHaveBeenCalledTimes(1);
      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(restarted.sandbox.getSandbox()?.snapshot_image_id).toBe("legacy-snapshot");
    });
  });

  it("captures near the graceful-drain boundary instead of interpreting checkpoint refusal as permission to destroy", async () => {
    const stub = await servingSession();
    await runInSessionDO(stub, async (instance, durableState) => {
      const provider = snapshotProvider();
      const { manager, sandbox } = realLifecycleHarness(instance, durableState, provider);
      const row = sandbox.getSandbox()!;
      const now = Date.now();
      new SandboxShutdownRepository(durableState.storage.sql).write({
        phase: "running",
        generation: { sandboxId: row.modal_sandbox_id!, createdAt: row.created_at },
        provider: "modal",
        providerObjectId: "legacy-source",
        sourceRetired: false,
        lifetimeKind: "finite",
        lifetimeSource: "provider",
        expiresAtMs: now + 600_000,
        drainAtMs: now + 1_000,
        generationReady: true,
        runtimeReady: true,
        protocolVersion: 1,
        lifecyclePolicy: "confirmed",
      });
      await manager.terminateUnresponsiveSandbox("prompt_dispatch_send_failed");
      expect(sandbox.getSandbox()?.snapshot_image_id).toBe("rescued-filesystem");
      expect(manager.shutdownSnapshot()).toMatchObject({
        phase: "saved",
        continuationPaused: true,
      });
    });
  });

  it("finishes retirement even when delivery of the committed receipt fails", async () => {
    const stub = await servingSession();
    await runInSessionDO(stub, async (instance, durableState) => {
      const provider = snapshotProvider({
        takeSnapshot: async () => ({ success: true, imageId: "committed-snapshot" }),
        stopSandbox: vi.fn(async () => ({ success: true })),
      });
      const { manager, sandbox } = realLifecycleHarness(instance, durableState, provider, {
        onAnnouncement: (message) => {
          if (
            "preservation" in message &&
            (message.preservation as { phase: string }).phase === "retiring"
          )
            throw new Error("socket fanout unavailable");
        },
      });
      await manager.terminateUnresponsiveSandbox("prompt_dispatch_send_failed");
      expect(sandbox.getSandbox()?.snapshot_image_id).toBe("committed-snapshot");
      expect(manager.shutdownSnapshot()).toMatchObject({ phase: "saved", hasRecoveryPoint: true });
    });
  });

  it("does not retire or expose a new receipt when snapshot recording fails", async () => {
    const stub = await servingSession();
    await runInSessionDO(stub, async (instance, durableState) => {
      durableState.storage.sql.exec(
        "CREATE TRIGGER reject_snapshot BEFORE UPDATE OF snapshot_image_id ON sandbox BEGIN SELECT RAISE(FAIL, 'injected persistence failure'); END"
      );
      const provider = snapshotProvider({
        takeSnapshot: async () => ({ success: true, imageId: "uncommitted-snapshot" }),
        stopSandbox: vi.fn(async () => ({ success: true })),
      });
      const { manager } = realLifecycleHarness(instance, durableState, provider);
      await manager.terminateUnresponsiveSandbox("prompt_dispatch_send_failed");
      expect(manager.shutdownSnapshot()).toMatchObject({
        phase: "unknown",
        hasRecoveryPoint: false,
      });
      const restarted = realLifecycleHarness(instance, durableState, provider);
      await restarted.manager.handleShutdownAlarm();
      await restarted.manager.spawnSandbox();
      expect(provider.stopSandbox).not.toHaveBeenCalled();
    });
  });

  it("keeps an incompatible legacy snapshot across repeated starts and coordinator reconstruction", async () => {
    const { stub } = await initNamedSession(`incompatible-legacy-snapshot-${Date.now()}`);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    await queryDO(stub, "DELETE FROM sandbox_preservation");
    await queryDO(
      stub,
      "UPDATE sandbox SET status = 'stopped', snapshot_image_id = 'valuable-old-snapshot', snapshot_runtime_version = 'v1-old', modal_object_id = 'old-source'"
    );
    await runInSessionDO(stub, async (instance, durableState) => {
      const provider = snapshotProvider();
      for (let attempt = 0; attempt < 2; attempt++) {
        const { manager, sandbox } = realLifecycleHarness(instance, durableState, provider);
        await manager.spawnSandbox();
        expect(sandbox.getSandbox()?.snapshot_image_id).toBe("valuable-old-snapshot");
        expect(manager.shutdownSnapshot()).toMatchObject({
          phase: "unknown",
          error: expect.stringContaining("No fresh sandbox"),
        });
      }
      expect(provider.createSandbox).not.toHaveBeenCalled();
      expect(provider.stopSandbox).not.toHaveBeenCalled();
    });
  });

  it("retains a recovery point before terminating a serving generation with no shutdown record", async () => {
    const stub = await servingSession();
    await runInSessionDO(stub, async (instance, durableState) => {
      let sourceExists = true;
      const provider = snapshotProvider({
        takeSnapshot: async () => ({ success: true, imageId: "rescued-filesystem" }),
        stopSandbox: async () => {
          sourceExists = false;
          return { success: true };
        },
      });
      const { manager, sandbox } = realLifecycleHarness(instance, durableState, provider);
      await manager.terminateUnresponsiveSandbox("prompt_dispatch_send_failed");
      expect(sandbox.getSandbox()?.snapshot_image_id).toBe("rescued-filesystem");
      expect(sourceExists).toBe(false);
      expect(manager.shutdownSnapshot()).toMatchObject({
        phase: "saved",
        hasRecoveryPoint: true,
        continuationPaused: true,
      });
    });
  });
});
