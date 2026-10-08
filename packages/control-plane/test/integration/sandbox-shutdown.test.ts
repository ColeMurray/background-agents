import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env, runDurableObjectAlarm } from "cloudflare:test";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import { SessionStatusProjectionStore } from "../../src/db/session-status-projection-store";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  SandboxLifecycleManager,
} from "../../src/sandbox/lifecycle/manager";
import { SandboxAccess } from "../../src/sandbox/lifecycle/sandbox-access";
import type { RestoreConfig, RestoreResult, SandboxProvider } from "../../src/sandbox/provider";
import { providerResumesAfterStop } from "../../src/sandbox/provider";
import { createLogger } from "../../src/logger";
import { EventRepository } from "../../src/session/event-repository";
import { MessageFailureService } from "../../src/session/message-failure-service";
import { MessageRepository } from "../../src/session/message-repository";
import { SessionMessengerImpl } from "../../src/session/messenger";
import { SandboxRuntimeEventHandler } from "../../src/session/sandbox-events/runtime.handler";
import { SandboxShutdownCoordinator } from "../../src/session/sandbox-shutdown";
import {
  SandboxShutdownRepository,
  type ShutdownStore,
} from "../../src/session/sandbox-shutdown-repository";
import { SessionAttachmentRepository } from "../../src/session/session-attachment-repository";
import { SessionCoreRepository } from "../../src/session/session-core-repository";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  initNamedSession,
  openClientWs,
  openSandboxWs,
  queryDO,
  seedMessage,
  seedSandboxAuth,
} from "./helpers";
import { componentsOf, runInSessionDO } from "./session-do-access";
import { realLifecycleHarness } from "./sandbox-lifecycle-harness";

const AUTH_TOKEN = "shutdown-integration-token";
const SANDBOX_ID = "shutdown-sandbox";

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

interface SandboxGeneration {
  sandboxId: string;
  createdAt: number;
}

async function seedShutdown(
  stub: DurableObjectStub,
  overrides: Record<string, unknown> = {}
): Promise<SandboxGeneration> {
  const [sandbox] = await queryDO<{ created_at: number }>(stub, "SELECT created_at FROM sandbox");
  const generation = { sandboxId: SANDBOX_ID, createdAt: sandbox.created_at };
  const now = Date.now();
  const state = {
    phase: "running",
    generation,
    providerObjectId: null,
    lifetimeKind: "finite",
    expiresAtMs: now + 30 * 60_000,
    drainAtMs: now + 20 * 60_000,
    generationReady: false,
    ...overrides,
  };
  await runInSessionDO(stub, (_instance: SessionDO, durableState) => {
    durableState.storage.sql.exec(
      `INSERT INTO sandbox_preservation (singleton, state) VALUES (1, ?)
       ON CONFLICT(singleton) DO UPDATE SET state = excluded.state`,
      JSON.stringify(state)
    );
  });
  return generation;
}

async function readShutdown(stub: DurableObjectStub): Promise<Record<string, unknown>> {
  const [row] = await queryDO<{ state: string }>(
    stub,
    "SELECT state FROM sandbox_preservation WHERE singleton = 1"
  );
  return JSON.parse(row.state) as Record<string, unknown>;
}

describe("sandbox graceful shutdown wiring", () => {
  it("retires access before detaching through the assembled shutdown callback without manager forwarding", async () => {
    const { stub } = await initNamedSession(`shutdown-access-composition-${Date.now()}`);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID, status: "ready" });
    await seedShutdown(stub, {
      generationReady: true,
      runtimeReady: true,
      lifecyclePolicy: "confirmed",
      protocolVersion: 1,
    });

    await runInSessionDO(stub, async (instance) => {
      const { sandboxRepository, lifecycleManager, wsManager } = componentsOf(instance);
      for (const kind of ["codeServer", "vnc", "ttyd"] as const) {
        await sandboxRepository.updateSandboxAccess(kind, `https://${kind}.example`, "secret");
      }
      sandboxRepository.updateSandboxTunnelUrls({ "8080": "https://port.example" });
      const pair = new WebSocketPair();
      wsManager.acceptAndSetSandboxSocket(pair[1], SANDBOX_ID);
      pair[0].accept();
      const clear = vi.spyOn(sandboxRepository, "clearSandboxAccess");
      const clearTunnels = vi.spyOn(sandboxRepository, "clearSandboxTunnelUrls");
      const broadcast = vi.spyOn(SessionMessengerImpl.prototype, "broadcast");
      const detach = vi.spyOn(wsManager, "detachSandboxSocket");
      const close = vi.spyOn(wsManager, "close");
      try {
        expect("retireShutdownAccess" in lifecycleManager).toBe(false);
        // With no provider handle, emergency shutdown retires access without outbound provider I/O.
        await lifecycleManager.terminateUnresponsiveSandbox("stop_send_failed");

        expect(clear.mock.calls).toEqual([["codeServer"], ["vnc"], ["ttyd"]]);
        expect(clearTunnels).toHaveBeenCalledOnce();
        const notificationIndex = broadcast.mock.calls.findIndex(
          ([message]) => message.type === "sandbox_access_changed"
        );
        expect(notificationIndex).toBeGreaterThanOrEqual(0);
        const notificationOrder = broadcast.mock.invocationCallOrder[notificationIndex];
        expect(
          Math.max(...clear.mock.invocationCallOrder, ...clearTunnels.mock.invocationCallOrder)
        ).toBeLessThan(notificationOrder);
        expect(notificationOrder).toBeLessThan(detach.mock.invocationCallOrder[0]);
        expect(detach).toHaveBeenCalledExactlyOnceWith(1000, "Sandbox state preserved");
        expect(close).toHaveBeenCalledExactlyOnceWith(pair[1], 1000, "Sandbox state preserved");
        expect(sandboxRepository.getSandbox()).toMatchObject({
          code_server_url: null,
          code_server_password: null,
          vnc_url: null,
          vnc_password: null,
          ttyd_url: null,
          ttyd_token: null,
          tunnel_urls: null,
          active_socket_id: "",
        });
      } finally {
        vi.restoreAllMocks();
        pair[0].close();
      }
    });
  });

  it("holds an interrupted legacy VM capture without recapture or retirement", async () => {
    const { stub } = await initNamedSession(`vm-capture-receipt-${Date.now()}`);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID, status: "ready" });
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sandbox SET modal_object_id = 'sb-captured'");
    });
    const now = Date.now();
    await seedShutdown(stub, {
      phase: "capturing",
      provider: "modal-vm",
      providerObjectId: "sb-captured",
      operationId: "lost-terminal-capture",
      captureReceiptPending: true,
      stopByMs: now - 120_000,
      captureByMs: now - 60_000,
      retireByMs: now - 30_000,
      generationReady: true,
      lifecyclePolicy: "confirmed",
      protocolVersion: 1,
    });
    const evidence = await runInSessionDO(stub, async (instance, durableState) => {
      let captureCount = 0;
      let stopCount = 0;
      const provider: SandboxProvider = {
        name: "modal-vm",
        capabilities: {
          supportsSandboxTimeout: true,
          supportsSnapshots: true,
          snapshotRequiresShutdown: true,
          supportsRestore: true,
          supportsExplicitStop: true,
        },
        createSandbox: async () => {
          throw new Error("must not create");
        },
        takeSnapshot: async () => {
          captureCount++;
          throw new Error("must not recapture");
        },
        stopSandbox: async () => {
          stopCount++;
          return { success: true };
        },
      };
      const restarted = realLifecycleHarness(instance, durableState, provider);
      await restarted.manager.handleShutdownAlarm();
      return { captureCount, stopCount, snapshot: restarted.manager.shutdownSnapshot() };
    });
    expect(evidence).toMatchObject({
      captureCount: 0,
      stopCount: 0,
      snapshot: { phase: "unknown", hasRecoveryPoint: false },
    });
    expect(await queryDO(stub, "SELECT snapshot_image_id FROM sandbox")).toEqual([
      { snapshot_image_id: null },
    ]);
  });

  it("discards a held VM through the lifecycle boundary so the next start is fresh", async () => {
    const { stub } = await initNamedSession(`vm-discard-${Date.now()}`);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID, status: "stale" });
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec(
        `UPDATE sandbox SET modal_object_id = 'sb-held', snapshot_image_id = 'im-older',
           snapshot_runtime_version = 'v1'`
      );
    });
    const now = Date.now();
    await seedShutdown(stub, {
      phase: "unknown",
      provider: "modal-vm",
      providerObjectId: "sb-held",
      error: "The provider did not confirm the save.",
      reason: "heartbeat_timeout",
      operationId: "failed-capture",
      stopByMs: now - 60_000,
      captureByMs: now + 240_000,
      retireByMs: now + 270_000,
      continuationPaused: true,
      generationReady: true,
      runtimeReady: true,
      lifecyclePolicy: "confirmed",
      protocolVersion: 1,
      receipt: {
        kind: "snapshot",
        artifactId: "im-older",
        provider: "modal-vm",
        savedAtMs: 1,
        runtimeVersion: "v1",
      },
    });
    const evidence = await runInSessionDO(stub, async (instance, durableState) => {
      const stopped: string[] = [];
      const provider: SandboxProvider = {
        name: "modal-vm",
        capabilities: {
          supportsSandboxTimeout: true,
          supportsSnapshots: true,
          snapshotRequiresShutdown: true,
          supportsRestore: true,
          supportsExplicitStop: true,
        },
        createSandbox: async () => {
          throw new Error("must not create during discard");
        },
        stopSandbox: async ({ providerObjectId }) => {
          stopped.push(providerObjectId);
          return { success: true };
        },
      };
      const restarted = realLifecycleHarness(instance, durableState, provider);
      const before = restarted.manager.shutdownSnapshot();
      await restarted.manager.recoverShutdown("discard");
      return {
        before,
        stopped,
        after: restarted.manager.shutdownSnapshot(),
        admission: restarted.manager.pushAdmissionDecision(),
      };
    });
    expect(evidence.before).toMatchObject({ phase: "unknown", discardAvailable: true });
    expect(evidence).toMatchObject({
      stopped: ["sb-held"],
      after: { phase: "running", hasRecoveryPoint: false, discardAvailable: false },
      admission: "start_required",
    });
    expect(
      await queryDO(stub, "SELECT status, snapshot_image_id, modal_object_id FROM sandbox")
    ).toEqual([{ status: "stopped", snapshot_image_id: null, modal_object_id: null }]);
  });

  it("saves an archived session's sandbox and keeps it through a reconnect during the save", async () => {
    const name = `archive-preserves-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID, status: "ready" });
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sandbox SET modal_object_id = 'sb-live'");
    });
    await seedShutdown(stub, {
      providerObjectId: "sb-live",
      generationReady: true,
      runtimeReady: true,
      protocolVersion: 1,
      lifecyclePolicy: "confirmed",
    });
    await queryDO(stub, "UPDATE session SET status = 'completed'");

    const archived = await stub.fetch("http://internal/internal/archive", { method: "POST" });
    expect(archived.status).toBe(200);
    expect(await readShutdown(stub)).toMatchObject({
      phase: "draining",
      reason: "session_archived",
    });

    // Archive refuses the runtime's reconnect; the save still needs its sandbox.
    const { ws, response } = await openSandboxWs(name, {
      authToken: AUTH_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).toBeNull();
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("Sandbox is being saved");
  });

  it("does not start preservation when the local archive status write fails", async () => {
    const { stub } = await initNamedSession(`archive-status-write-failure-${Date.now()}`);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID, status: "ready" });
    await seedShutdown(stub, {
      generationReady: true,
      runtimeReady: true,
      protocolVersion: 1,
      lifecyclePolicy: "confirmed",
    });
    await queryDO(stub, "UPDATE session SET status = 'completed'");
    const shutdownBefore = await readShutdown(stub);

    await runInSessionDO(stub, async (instance, state) => {
      state.storage.sql.exec(
        `CREATE TRIGGER fail_archive_status BEFORE UPDATE OF status ON session
         WHEN NEW.status = 'archived'
         BEGIN SELECT RAISE(ABORT, 'injected archive status write failure'); END`
      );
      try {
        await expect(componentsOf(instance).sessionLifecycleHandler.archive()).rejects.toThrow(
          "injected archive status write failure"
        );
      } finally {
        state.storage.sql.exec("DROP TRIGGER fail_archive_status");
      }
    });

    expect(await readShutdown(stub)).toEqual(shutdownBefore);
    expect(await queryDO(stub, "SELECT status FROM session")).toEqual([{ status: "completed" }]);
  });

  it("keeps an archived sandbox alive while the status projection is pending", async () => {
    const name = `archive-pending-projection-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID, status: "ready" });
    await runInSessionDO(stub, (_instance, state) => {
      state.storage.sql.exec("UPDATE sandbox SET modal_object_id = 'sb-live'");
    });
    await seedShutdown(stub, {
      providerObjectId: "sb-live",
      generationReady: true,
      runtimeReady: true,
      protocolVersion: 1,
      lifecyclePolicy: "confirmed",
    });
    await queryDO(stub, "UPDATE session SET status = 'completed'");

    // Create and release the gate inside the DO to retain its I/O context.
    let releaseProjection: (() => void) | undefined;
    await runInSessionDO(stub, () => {
      const project = SessionStatusProjectionStore.prototype.project;
      vi.spyOn(SessionStatusProjectionStore.prototype, "project").mockImplementationOnce(
        async function (this: SessionStatusProjectionStore, ...args) {
          await new Promise<void>((resolve) => {
            releaseProjection = resolve;
          });
          return project.call(this, ...args);
        }
      );
    });

    const archiving = stub.fetch("http://internal/internal/archive", { method: "POST" });
    const archiveSettled = archiving.catch(() => undefined);
    try {
      await vi.waitFor(() => expect(releaseProjection).toBeTypeOf("function"));
      expect(await queryDO(stub, "SELECT status FROM session")).toEqual([{ status: "archived" }]);
      const { ws, response } = await openSandboxWs(name, {
        authToken: AUTH_TOKEN,
        sandboxId: SANDBOX_ID,
      });
      expect(ws).toBeNull();
      expect(response.status).toBe(503);
      expect(await response.text()).toBe("Sandbox is being saved");
      expect(await readShutdown(stub)).toMatchObject({
        phase: "draining",
        reason: "session_archived",
      });
    } finally {
      await runInSessionDO(stub, () => {
        releaseProjection?.();
        vi.restoreAllMocks();
      });
      await archiveSettled;
    }

    expect((await archiving).status).toBe(200);
    expect(await readShutdown(stub)).toMatchObject({
      phase: "draining",
      reason: "session_archived",
    });
  });

  it.each(["missing", "legacy"])(
    "tells an archived sandbox to exit when its shutdown record is %s",
    async (policy) => {
      const name = `archive-unmanaged-${policy}-${Date.now()}`;
      const { stub } = await initNamedSession(name);
      await seedSandboxAuth(stub, {
        authToken: AUTH_TOKEN,
        sandboxId: SANDBOX_ID,
        status: "ready",
      });
      if (policy === "legacy") {
        await seedShutdown(stub, { lifecyclePolicy: "legacy" });
      }
      await queryDO(stub, "UPDATE session SET status = 'completed'");

      const archived = await stub.fetch("http://internal/internal/archive", { method: "POST" });
      expect(archived.status).toBe(200);
      const { ws, response } = await openSandboxWs(name, {
        authToken: AUTH_TOKEN,
        sandboxId: SANDBOX_ID,
      });
      expect(ws).toBeNull();
      expect(response.status).toBe(410);
      expect(await response.text()).toBe("Session is terminal");
    }
  );

  it("preserves a completed session status when shutdown begins between prompts", async () => {
    const name = `shutdown-completed-status-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    await seedShutdown(stub, { drainAtMs: Date.now() - 1 });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "completed-before-shutdown",
      authorId,
      content: "Completed before inactivity shutdown",
      source: "web",
      status: "completed",
      createdAt: Date.now(),
    });
    await queryDO(stub, "UPDATE session SET status = 'completed'");

    await runInSessionDO(stub, async (instance) => {
      await expect(componentsOf(instance).lifecycleManager.handleShutdownAlarm()).resolves.toBe(
        "hold_watchdogs"
      );
    });

    await vi.waitFor(async () => {
      expect(await queryDO<{ status: string }>(stub, "SELECT status FROM session")).toEqual([
        { status: "completed" },
      ]);
      await expect(
        env.DB.prepare("SELECT status FROM sessions WHERE id = ?").bind(name).first()
      ).resolves.toEqual({ status: "completed" });
    });
  });

  it("fails an interrupted prompt before reconciling shutdown status", async () => {
    const name = `shutdown-interrupted-status-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    await seedShutdown(stub, { drainAtMs: Date.now() - 1 });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    const now = Date.now();
    await seedMessage(stub, {
      id: "processing-at-shutdown",
      authorId,
      content: "Interrupted by inactivity shutdown",
      source: "web",
      status: "processing",
      createdAt: now - 1_000,
      startedAt: now,
    });
    await queryDO(stub, "UPDATE session SET status = 'active'");

    await runInSessionDO(stub, async (instance) => {
      await expect(componentsOf(instance).lifecycleManager.handleShutdownAlarm()).resolves.toBe(
        "hold_watchdogs"
      );
    });

    await vi.waitFor(async () => {
      expect(
        await queryDO<{ status: string }>(
          stub,
          "SELECT status FROM messages WHERE id = 'processing-at-shutdown'"
        )
      ).toEqual([{ status: "failed" }]);
      expect(await queryDO<{ status: string }>(stub, "SELECT status FROM session")).toEqual([
        { status: "failed" },
      ]);
      await expect(
        env.DB.prepare("SELECT status FROM sessions WHERE id = ?").bind(name).first()
      ).resolves.toEqual({ status: "failed" });
    });
  });

  it("rolls back the sandbox reservation when the matching shutdown write fails", async () => {
    const { stub } = await initNamedSession(`shutdown-reservation-rollback-${Date.now()}`);
    await seedSandboxAuth(stub, {
      authToken: AUTH_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "stopped",
    });
    await runInSessionDO(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        `UPDATE sandbox
         SET modal_object_id = ?, snapshot_image_id = ?, snapshot_runtime_version = ?`,
        "old-provider-object",
        "saved-snapshot",
        "v62-legacy-runtime"
      );
    });
    await seedShutdown(stub, {
      phase: "saved",
      provider: "modal",
      providerObjectId: "old-provider-object",
      sourceRetired: true,
      lifetimeKind: "none",
      expiresAtMs: null,
      drainAtMs: null,
      generationReady: true,
      receipt: {
        kind: "snapshot",
        artifactId: "saved-snapshot",
        provider: "modal",
        savedAtMs: Date.now(),
        runtimeVersion: "v62-legacy-runtime",
      },
    });
    const [sandboxBefore] = await queryDO<{
      modal_sandbox_id: string;
      modal_object_id: string | null;
      created_at: number;
      status: string;
    }>(stub, "SELECT modal_sandbox_id, modal_object_id, created_at, status FROM sandbox");
    const shutdownBefore = await readShutdown(stub);

    const restoreFromSnapshot = vi.fn(async (): Promise<RestoreResult> => {
      throw new Error("provider must not run when reservation fails");
    });
    const provider: SandboxProvider = {
      name: "modal",
      capabilities: {
        supportsSandboxTimeout: true,
        supportsSnapshots: true,
        supportsRestore: true,
        supportsExplicitStop: true,
      },
      createSandbox: async () => {
        throw new Error("fresh provider create must not run");
      },
      restoreFromSnapshot,
    };

    const result = await runInSessionDO(stub, async (instance, durableState) => {
      const realStore = new SandboxShutdownRepository(durableState.storage.sql);
      const throwingStore: ShutdownStore = {
        read: () => realStore.read(),
        write: () => {
          throw new Error("injected shutdown write failure");
        },
      };
      const harness = realLifecycleHarness(instance, durableState, provider, {
        store: throwingStore,
      });

      await harness.manager.spawnSandbox();
      return {
        shutdownAnnouncements: harness.shutdownAnnouncements,
        lifecycleAnnouncements: harness.lifecycleAnnouncements,
      };
    });

    expect(restoreFromSnapshot).not.toHaveBeenCalled();
    expect(
      await queryDO(
        stub,
        "SELECT modal_sandbox_id, modal_object_id, created_at, status FROM sandbox"
      )
    ).toEqual([sandboxBefore]);
    expect(await readShutdown(stub)).toEqual(shutdownBefore);
    expect(result.shutdownAnnouncements).toEqual([]);
    expect(result.lifecycleAnnouncements).not.toContainEqual({
      type: "sandbox_status",
      status: "spawning",
    });
  });

  it("accepts early ready for a saved restore but gates the queue until provider lifetime settles", async () => {
    const { stub } = await initNamedSession(`shutdown-early-ready-${Date.now()}`);
    await seedSandboxAuth(stub, {
      authToken: AUTH_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "stopped",
    });
    await runInSessionDO(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        `UPDATE sandbox
         SET modal_object_id = NULL, snapshot_image_id = ?, snapshot_runtime_version = ?`,
        "saved-snapshot",
        "v62-legacy-runtime"
      );
    });
    await seedShutdown(stub, {
      phase: "saved",
      provider: "modal",
      providerObjectId: null,
      sourceRetired: true,
      lifetimeKind: "none",
      expiresAtMs: null,
      drainAtMs: null,
      generationReady: true,
      receipt: {
        kind: "snapshot",
        artifactId: "saved-snapshot",
        provider: "modal",
        savedAtMs: Date.now(),
        runtimeVersion: "v62-legacy-runtime",
      },
    });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "restore-pending",
      authorId,
      content: "Wait for the restore lifetime",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    let resolveRestore!: (result: RestoreResult) => void;
    const restoreFromSnapshot = vi.fn(
      (_config: RestoreConfig) =>
        new Promise<RestoreResult>((resolve) => {
          resolveRestore = resolve;
        })
    );
    const provider: SandboxProvider = {
      name: "modal",
      capabilities: {
        supportsSandboxTimeout: true,
        supportsSnapshots: true,
        supportsRestore: true,
        supportsExplicitStop: true,
      },
      createSandbox: async () => {
        throw new Error("saved restore must not create a fresh sandbox");
      },
      restoreFromSnapshot,
    };

    const evidence = await runInSessionDO(stub, async (instance, durableState) => {
      const harness = realLifecycleHarness(instance, durableState, provider, {
        onQueueAdmission: (decision) => {
          if (decision === "ready") {
            durableState.storage.sql.exec(
              "UPDATE messages SET status = 'processing' WHERE id = ? AND status = 'pending'",
              "restore-pending"
            );
          }
        },
      });
      const restoring = harness.manager.spawnSandbox();
      await vi.waitFor(() => expect(restoreFromSnapshot).toHaveBeenCalledOnce());
      const restoreConfig = restoreFromSnapshot.mock.calls[0]?.[0];
      if (!restoreConfig) throw new Error("Expected deferred snapshot restore config");

      // Runtime readiness arrives while the provider is still resolving the
      // restored sandbox's authoritative lifetime and provider handle.
      const runtimeHandler = new SandboxRuntimeEventHandler(
        harness.sessions,
        harness.sandbox,
        new EventRepository(durableState.storage.sql, (callback) =>
          durableState.storage.transactionSync(callback)
        ),
        { broadcast: (message: object) => harness.lifecycleAnnouncements.push(message) } as never,
        { pinBaselines: () => undefined } as never,
        ((title: string) => ({ ok: true, title })) as never,
        () => undefined,
        () => undefined,
        async () => undefined,
        {
          submit: (task: () => Promise<void>) => {
            void task();
          },
        },
        { processMessageQueue: harness.processQueue },
        {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          child: () => undefined,
        } as never,
        harness.manager
      );
      await runtimeHandler.handleReady(
        {
          type: "ready",
          harness: "opencode",
          runtimeVersion: "v62-legacy-runtime",
          sandboxId: restoreConfig.sandboxId,
          timestamp: Date.now() / 1000,
        },
        { now: Date.now(), messageId: null, processingMessage: null }
      );
      const statusBeforeProvider = durableState.storage.sql
        .exec("SELECT status FROM sandbox")
        .toArray()[0] as { status: string };
      const messageBeforeProvider = durableState.storage.sql
        .exec("SELECT status FROM messages WHERE id = ?", "restore-pending")
        .toArray()[0] as { status: string };

      resolveRestore({
        success: true,
        sandboxId: restoreConfig.sandboxId,
        providerObjectId: "restored-provider-object",
        lifetime: { kind: "none", observedAtMs: Date.now() },
      });
      await restoring;

      return {
        statusBeforeProvider,
        messageBeforeProvider,
        queueAdmissions: harness.queueAdmissions,
      };
    });

    expect(evidence.statusBeforeProvider).toEqual({ status: "ready" });
    expect(evidence.messageBeforeProvider).toEqual({ status: "pending" });
    expect(evidence.queueAdmissions.slice(0, -1).length).toBeGreaterThanOrEqual(2);
    expect(new Set(evidence.queueAdmissions.slice(0, -1))).toEqual(new Set(["held"]));
    expect(evidence.queueAdmissions.at(-1)).toBe("ready");
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "ready" },
    ]);
    expect(
      await queryDO<{ status: string }>(
        stub,
        "SELECT status FROM messages WHERE id = ?",
        "restore-pending"
      )
    ).toEqual([{ status: "processing" }]);
    expect(await readShutdown(stub)).toMatchObject({
      phase: "running",
      runtimeReady: true,
      providerObjectId: "restored-provider-object",
    });
  });

  it("rejects push from saved state when no live sandbox is available", async () => {
    const { stub } = await initNamedSession(`shutdown-saved-push-${Date.now()}`);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    await seedShutdown(stub, {
      phase: "saved",
      provider: "modal",
      providerObjectId: "provider-1",
      sourceRetired: true,
      lifetimeKind: "none",
      expiresAtMs: null,
      drainAtMs: null,
      generationReady: true,
      receipt: {
        kind: "snapshot",
        artifactId: "snapshot-1",
        provider: "modal",
        savedAtMs: Date.now(),
        runtimeVersion: "v71-runtime",
      },
    });

    const result = await runInSessionDO(stub, (instance) =>
      componentsOf(instance).pushService.pushBranchToRemote({
        remoteUrl: "https://token@example.com/acme/web-app.git",
        redactedRemoteUrl: "https://***@example.com/acme/web-app.git",
        refspec: "HEAD:refs/heads/feature/saved",
        targetBranch: "feature/saved",
        repoOwner: "acme",
        repoName: "web-app",
        force: false,
      })
    );

    expect(result).toEqual({
      success: false,
      error: "Sandbox must be started before pushing; retry once ready",
    });
  });

  it("snapshots an unmanaged destructive provider before inactivity destroys it", async () => {
    const { stub } = await initNamedSession(`shutdown-unmanaged-${Date.now()}`);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    const now = Date.now();
    await runInSessionDO(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        `UPDATE sandbox
         SET modal_object_id = ?, runtime_version = ?, last_activity = ?, last_heartbeat = ?`,
        "vercel-session-1",
        "v62-legacy-runtime",
        now - 11 * 60_000,
        now - 10_000
      );
    });

    const calls = await runInSessionDO(stub, async (instance, durableState) => {
      const calls: string[] = [];
      const provider: SandboxProvider = {
        name: "vercel",
        capabilities: {
          supportsSandboxTimeout: true,
          supportsSnapshots: true,
          supportsRestore: true,
          supportsExplicitStop: true,
          supportsPersistentResume: false,
          snapshotRequiresShutdown: true,
        },
        createSandbox: async () => {
          throw new Error("not used by inactivity regression");
        },
        takeSnapshot: async () => {
          calls.push("snapshot");
          return {
            success: true as const,
            imageId: "legacy-vercel-snapshot",
            sourceStopped: true,
          };
        },
        stopSandbox: async () => {
          const [row] = durableState.storage.sql
            .exec("SELECT snapshot_image_id FROM sandbox")
            .toArray() as Array<{ snapshot_image_id: string | null }>;
          expect(row?.snapshot_image_id).toBe("legacy-vercel-snapshot");
          calls.push("stop");
          return { success: true };
        },
      };
      const sandbox = componentsOf(instance).sandboxRepository;
      const broadcaster = { broadcast: () => undefined };
      const sockets = {
        getSandboxWebSocket: () => null,
        getConnectedClientCount: () => 0,
        sendToSandbox: () => false,
        detachSandboxWebSocket: () => undefined,
      };
      const log = createLogger("shutdown-test");
      const access = new SandboxAccess({
        storage: sandbox,
        broadcaster,
        sockets,
        canResumeAfterStop: () => providerResumesAfterStop(provider),
        getLogger: () => log,
      });
      const shutdown = new SandboxShutdownCoordinator({
        store: new SandboxShutdownRepository(durableState.storage.sql),
        provider,
        sandbox,
        session: {
          getSession: () => ({ id: "session-1", session_name: "legacy-session" }),
        },
        messenger: broadcaster,
        background: {
          submit: (task: () => Promise<void>) => {
            void task();
          },
        },
        onLifecycleChange: async () => undefined,
        retireAccess: () => access.retireShutdownAccess(),
      } as never);
      const manager = new SandboxLifecycleManager(
        provider,
        sandbox,
        {
          getSession: () => ({ id: "session-1", session_name: "legacy-session" }),
          getSessionRepositories: () => [],
          getUserEnvVars: async () => undefined,
        } as never,
        broadcaster,
        sockets,
        { schedule: async () => undefined, cancel: async () => undefined } as never,
        { generateId: () => "generated-id" },
        shutdown,
        access,
        {
          ...DEFAULT_LIFECYCLE_CONFIG,
          controlPlaneUrl: "https://control-plane.test",
          model: "anthropic/claude-sonnet-4-5",
        }
      );
      await manager.handleAlarm();
      return calls;
    });

    expect(calls).toEqual(["snapshot", "stop"]);
    expect(
      await queryDO<{ snapshot_image_id: string | null }>(
        stub,
        "SELECT snapshot_image_id FROM sandbox"
      )
    ).toEqual([{ snapshot_image_id: "legacy-vercel-snapshot" }]);
  });

  it("holds queued work until a versioned runtime acknowledges its sandbox generation", async () => {
    const name = `shutdown-generation-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    const generation = await seedShutdown(stub);
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "shutdown-pending",
      authorId,
      content: "Run only after generation acknowledgement",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    const { ws } = await openSandboxWs(name, {
      authToken: AUTH_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    const commands = collectMessages(ws!, {
      until: (message) => message.type === "sandbox_generation",
      timeoutMs: 2_000,
    });
    ws!.send(
      JSON.stringify({
        type: "ready",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
        preservationProtocolVersion: 1,
      })
    );

    expect(await commands).toContainEqual({ type: "sandbox_generation", generation });
    expect(
      await queryDO<{ status: string }>(
        stub,
        "SELECT status FROM messages WHERE id = ?",
        "shutdown-pending"
      )
    ).toEqual([{ status: "pending" }]);

    const delivered = collectMessages(ws!, {
      until: (message) => message.type === "prompt",
      timeoutMs: 2_000,
    });
    ws!.send(
      JSON.stringify({
        type: "sandbox_generation_ready",
        generation,
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
        ackId: "generation-ready-ack",
      })
    );
    const messages = await delivered;
    expect(messages).toContainEqual({ type: "ack", ackId: "generation-ready-ack" });
    expect(messages).toContainEqual(
      expect.objectContaining({ type: "prompt", messageId: "shutdown-pending" })
    );
    ws!.close();
  });

  it("dispatches restored legacy work when ready omits the shutdown protocol", async () => {
    const name = `shutdown-legacy-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: AUTH_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    await seedShutdown(stub, {
      lifecyclePolicy: "legacy",
      lifetimeKind: "none",
      expiresAtMs: null,
      drainAtMs: null,
    });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "legacy-pending",
      authorId,
      content: "Continue existing work",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    const { ws } = await openSandboxWs(name, {
      authToken: AUTH_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    const delivered = collectMessages(ws!, {
      until: (message) => message.type === "prompt",
      timeoutMs: 2_000,
    });
    ws!.send(
      JSON.stringify({
        type: "ready",
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
      })
    );

    expect(await delivered).toContainEqual(
      expect.objectContaining({ type: "prompt", messageId: "legacy-pending" })
    );
    expect(await readShutdown(stub)).toMatchObject({
      phase: "running",
      lifecyclePolicy: "legacy",
      runtimeReady: true,
    });
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "ready" },
    ]);
    ws!.close();
  });

  it("keeps interrupted continuation paused across restart until an authenticated restore", async () => {
    const name = `shutdown-paused-continuation-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    await runInSessionDO(stub, (_instance, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE sandbox SET modal_object_id = ?, runtime_version = ?",
        "provider-current",
        "v72-runtime"
      );
    });
    const generation = await seedShutdown(stub, {
      provider: "modal",
      providerObjectId: "provider-current",
      sourceRetired: false,
      generationReady: true,
      runtimeReady: true,
      protocolVersion: 1,
      lifecyclePolicy: "confirmed",
    });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    const now = Date.now();
    await seedMessage(stub, {
      id: "interrupted-active",
      authorId,
      content: "Preserve this partial execution",
      source: "web",
      status: "processing",
      createdAt: now - 2_000,
      startedAt: now - 1_000,
    });
    await seedMessage(stub, {
      id: "pending-before-restart",
      authorId,
      content: "Run only after explicit resume",
      source: "web",
      status: "pending",
      createdAt: now,
    });

    const takeSnapshot = vi.fn(async () => ({
      success: true as const,
      imageId: "paused-continuation-snapshot",
      sourceStopped: true,
    }));
    const provider: SandboxProvider = {
      name: "modal",
      capabilities: {
        supportsSandboxTimeout: true,
        supportsSnapshots: true,
        supportsRestore: true,
        supportsExplicitStop: true,
      },
      createSandbox: async () => {
        throw new Error("fresh creation is not part of the interruption fixture");
      },
      takeSnapshot,
    };

    await runInSessionDO(stub, async (instance, durableState) => {
      const sql = durableState.storage.sql;
      const transaction = <T>(callback: () => T) => durableState.storage.transactionSync(callback);
      const sessions = new SessionCoreRepository(sql, transaction);
      const events = new EventRepository(sql, transaction);
      const messages = new MessageRepository(
        sql,
        transaction,
        new SessionAttachmentRepository(sql),
        events
      );
      const background = {
        submit: (task: () => Promise<void>) => {
          void task();
        },
      };
      const messenger = {
        broadcast: () => undefined,
        sendToSandbox: async () => undefined,
      };
      const failures = new MessageFailureService(
        background,
        {
          debug: () => undefined,
          info: () => undefined,
          warn: () => undefined,
          error: () => undefined,
          child: () => undefined,
        } as never,
        messages,
        messenger,
        { notifyComplete: async () => undefined } as never,
        async () => undefined
      );
      const coordinator = new SandboxShutdownCoordinator({
        store: new SandboxShutdownRepository(sql),
        provider,
        sandbox: componentsOf(instance).sandboxRepository,
        session: sessions,
        messages,
        failures,
        messenger,
        sockets: { getSandboxSocket: () => null, send: () => false },
        alarm: { schedule: async () => undefined },
        background,
        onLifecycleChange: async () => undefined,
        reconcileStatusFromMessages: async () => undefined,
        retireAccess: () => undefined,
      } as never);

      await expect(coordinator.requestShutdown("sandbox_lifetime_expiring")).resolves.toBe("owned");
      const draining = new SandboxShutdownRepository(sql).read();
      expect(draining).toMatchObject({
        phase: "draining",
        messageId: "interrupted-active",
        continuationPaused: true,
      });
      coordinator.prepared({
        type: "preservation_prepared",
        operationId: draining!.operationId!,
        generation,
        executionStopped: true,
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1_000,
      });
      await vi.waitFor(() =>
        expect(new SandboxShutdownRepository(sql).read()).toMatchObject({
          phase: "saved",
          continuationPaused: true,
          sourceRetired: true,
          receipt: { artifactId: "paused-continuation-snapshot" },
        })
      );
    });

    expect(takeSnapshot).toHaveBeenCalledOnce();
    expect(
      await queryDO<{ id: string; status: string }>(
        stub,
        "SELECT id, status FROM messages WHERE id IN (?, ?) ORDER BY id",
        "interrupted-active",
        "pending-before-restart"
      )
    ).toEqual([
      { id: "interrupted-active", status: "failed" },
      { id: "pending-before-restart", status: "pending" },
    ]);

    await seedMessage(stub, {
      id: "pending-after-restart",
      authorId,
      content: "Also remain queued until explicit resume",
      source: "web",
      status: "pending",
      createdAt: now + 1,
    });
    const restartEvidence = await runInSessionDO(stub, async (instance, durableState) => {
      const store = new SandboxShutdownRepository(durableState.storage.sql);
      const admissions: string[] = [];
      const restarted = new SandboxShutdownCoordinator({
        store,
        provider,
        sandbox: componentsOf(instance).sandboxRepository,
        messenger: { broadcast: () => undefined },
        sockets: { getSandboxSocket: () => null, send: () => false },
        alarm: { schedule: async () => undefined },
        background: {
          submit: (task: () => Promise<void>) => {
            void task();
          },
        },
        onLifecycleChange: async () => {
          admissions.push(restarted.admissionDecision());
        },
      } as never);

      expect(restarted.startupDecision()).toMatchObject({ kind: "hold" });
      expect(restarted.admissionDecision()).toBe("held");
      restarted.runtimeReady(1);
      restarted.generationReady({
        type: "sandbox_generation_ready",
        generation,
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1_000,
      });
      await expect(restarted.handleAlarm()).resolves.toBe("hold_watchdogs");
      await vi.waitFor(() => expect(admissions).not.toEqual([]));
      return { admissions, state: store.read() };
    });
    expect(restartEvidence.admissions).toEqual(["held"]);
    expect(restartEvidence.state).toMatchObject({
      phase: "saved",
      continuationPaused: true,
    });

    const anonymous = await openClientWs(name);
    anonymous.ws.send(JSON.stringify({ type: "recover_preservation", action: "restore_saved" }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(await readShutdown(stub)).toMatchObject({ continuationPaused: true });
    anonymous.ws.close();

    const authenticated = await openClientWs(name, { subscribe: true });
    const accepted = collectMessages(authenticated.ws, {
      until: (message) => message.type === "shutdown_recovery_accepted",
    });
    authenticated.ws.send(
      JSON.stringify({
        type: "recover_preservation",
        action: "restore_saved",
        clientRequestId: "resume-1",
      })
    );
    await expect(accepted).resolves.toContainEqual({
      type: "shutdown_recovery_accepted",
      clientRequestId: "resume-1",
      action: "restore_saved",
    });
    // The integration outbound service answers every *.modal.run call with 404, so this restore
    // always fails. Wait for that terminal state rather than for the pause to lift: the pause lifts
    // at "restoring" while the restore is still in flight, so waiting on it raced the failure.
    await vi.waitFor(async () => {
      expect(await readShutdown(stub)).toMatchObject({ phase: "unknown" });
      expect(await readShutdown(stub)).not.toMatchObject({ continuationPaused: true });
    });
    // A failed restore retains the receipt and deliberately re-offers restore_saved, so a further
    // authenticated request is accepted rather than rejected.
    const retried = collectMessages(authenticated.ws, {
      until: (message) => message.type === "shutdown_recovery_accepted",
    });
    authenticated.ws.send(
      JSON.stringify({
        type: "recover_preservation",
        action: "restore_saved",
        clientRequestId: "retry-1",
      })
    );
    await expect(retried).resolves.toContainEqual({
      type: "shutdown_recovery_accepted",
      clientRequestId: "retry-1",
      action: "restore_saved",
    });
    authenticated.ws.close();

    expect(
      await queryDO<{ id: string; status: string }>(
        stub,
        "SELECT id, status FROM messages WHERE id IN (?, ?, ?) ORDER BY id",
        "interrupted-active",
        "pending-before-restart",
        "pending-after-restart"
      )
    ).toEqual([
      { id: "interrupted-active", status: "failed" },
      { id: "pending-after-restart", status: "pending" },
      { id: "pending-before-restart", status: "pending" },
    ]);
    expect(
      await queryDO<{ count: number }>(
        stub,
        "SELECT COUNT(*) AS count FROM events WHERE type = 'execution_complete' AND message_id = ?",
        "interrupted-active"
      )
    ).toEqual([{ count: 1 }]);
  });

  it("drains once, holds pending work, and acknowledges only matching preparation state", async () => {
    const name = `shutdown-drain-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    const generation = await seedShutdown(stub, {
      drainAtMs: Date.now() - 1,
      generationReady: true,
      runtimeReady: true,
      protocolVersion: 1,
    });
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "shutdown-processing",
      authorId,
      content: "Stop before shutdown",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_000,
    });
    await seedMessage(stub, {
      id: "shutdown-held",
      authorId,
      content: "Remain pending",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });

    const { ws } = await openSandboxWs(name, {
      authToken: AUTH_TOKEN,
      sandboxId: SANDBOX_ID,
    });
    expect(ws).not.toBeNull();
    ws!.accept();
    const preparation = collectMessages(ws!, {
      until: (message) => message.type === "prepare_preservation",
      timeoutMs: 2_000,
    });
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());
    const prepare = (await preparation).find((message) => message.type === "prepare_preservation");
    expect(prepare).toMatchObject({
      generation,
      messageId: "shutdown-processing",
      operationId: expect.any(String),
    });
    expect(
      await queryDO<{ id: string; status: string }>(
        stub,
        "SELECT id, status FROM messages WHERE id IN (?, ?) ORDER BY id",
        "shutdown-processing",
        "shutdown-held"
      )
    ).toEqual([
      { id: "shutdown-held", status: "pending" },
      { id: "shutdown-processing", status: "failed" },
    ]);
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());
    expect(
      await queryDO<{ count: number }>(
        stub,
        "SELECT COUNT(*) AS count FROM events WHERE type = 'execution_complete' AND message_id = ?",
        "shutdown-processing"
      )
    ).toEqual([{ count: 1 }]);

    const staleAck = collectMessages(ws!, {
      until: (message) => message.type === "ack" && message.ackId === "stale-prepared",
      timeoutMs: 2_000,
    });
    ws!.send(
      JSON.stringify({
        type: "preservation_prepared",
        operationId: "stale-operation",
        generation,
        executionStopped: true,
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
        ackId: "stale-prepared",
      })
    );
    expect(await staleAck).toContainEqual({ type: "ack", ackId: "stale-prepared" });
    expect(await readShutdown(stub)).toMatchObject({ phase: "draining" });

    const matchingAck = collectMessages(ws!, {
      until: (message) => message.type === "ack" && message.ackId === "matching-prepared",
      timeoutMs: 2_000,
    });
    ws!.send(
      JSON.stringify({
        type: "preservation_prepared",
        operationId: prepare!.operationId,
        generation,
        executionStopped: true,
        sandboxId: SANDBOX_ID,
        timestamp: Date.now() / 1000,
        ackId: "matching-prepared",
      })
    );
    expect(await matchingAck).toContainEqual({ type: "ack", ackId: "matching-prepared" });
    expect(await readShutdown(stub)).toMatchObject({ phase: "failed" });
    ws!.close();
  });
});

describe("unconfirmed checkpoint across a Durable Object reset", () => {
  /** A coordinator over the instance's real SQLite repositories. */
  function realCoordinator(
    instance: SessionDO,
    durableState: DurableObjectState,
    provider: SandboxProvider,
    now?: () => number
  ) {
    const sql = durableState.storage.sql;
    const transaction = <T>(callback: () => T) => durableState.storage.transactionSync(callback);
    const events = new EventRepository(sql, transaction);
    return new SandboxShutdownCoordinator({
      store: new SandboxShutdownRepository(sql),
      provider,
      sandbox: componentsOf(instance).sandboxRepository,
      session: new SessionCoreRepository(sql, transaction),
      messages: new MessageRepository(
        sql,
        transaction,
        new SessionAttachmentRepository(sql),
        events
      ),
      events,
      messenger: { broadcast: () => undefined },
      sockets: { getSandboxSocket: () => null, send: () => false },
      alarm: { schedule: async () => undefined },
      background: { submit: () => undefined },
      onLifecycleChange: async () => undefined,
      reconcileStatusFromMessages: async () => undefined,
      retireAccess: () => undefined,
      now,
    } as never);
  }

  it("keeps the checkpoint through eviction and releases it on the replacement instance", async () => {
    const name = `checkpoint-eviction-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID, status: "ready" });
    await runInSessionDO(stub, (_instance: SessionDO, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE sandbox SET modal_object_id = ?, last_heartbeat = ?",
        "provider-object",
        Date.now()
      );
    });
    const generation = await seedShutdown(stub, {
      generationReady: true,
      runtimeReady: true,
      lifecyclePolicy: "confirmed",
      protocolVersion: 1,
      providerObjectId: "provider-object",
    });
    const provider = {
      name: "modal",
      capabilities: {
        supportsSandboxTimeout: true,
        supportsSnapshots: true,
        supportsRestore: true,
        supportsExplicitStop: true,
      },
      // The answer is lost with the instance that asked for it.
      takeSnapshot: vi.fn(() => new Promise<never>(() => {})),
    } as unknown as SandboxProvider;

    await runInSessionDO(stub, async (instance: SessionDO, durableState) => {
      const coordinator = realCoordinator(instance, durableState, provider);
      void coordinator.captureCheckpoint(generation, "execution_complete", "continue");
      await vi.waitFor(() => expect(provider.takeSnapshot).toHaveBeenCalledOnce());
    });
    await expect(
      runInSessionDO(stub, (_instance: SessionDO, durableState) => {
        durableState.abort("test: reset during checkpoint");
      })
    ).rejects.toThrow();

    const restored = env.SESSION.get(env.SESSION.idFromName(name));
    const persisted = await readShutdown(restored);
    expect(persisted).toMatchObject({
      phase: "running",
      checkpointInFlight: true,
      captureOp: { kind: "checkpoint", after: "continue", attempt: 1 },
    });
    const op = persisted.captureOp as { id: string; settleAtMs: number };
    expect(await queryDO<{ status: string }>(restored, "SELECT status FROM sandbox")).toEqual([
      { status: "snapshotting" },
    ]);

    const settled = await runInSessionDO(restored, async (instance: SessionDO, durableState) => {
      componentsOf(instance).sandboxRepository.updateSandboxHeartbeat(op.settleAtMs - 1_000);
      const coordinator = realCoordinator(instance, durableState, provider, () => op.settleAtMs);
      return coordinator.handleAlarm();
    });

    expect(settled).toBe("continue");
    const released = await readShutdown(restored);
    expect(released).toMatchObject({ phase: "running", checkpointInFlight: false });
    expect(released).not.toHaveProperty("captureOp");
    expect(
      await queryDO<{ status: string; last_activity: number }>(
        restored,
        "SELECT status, last_activity FROM sandbox"
      )
    ).toEqual([{ status: "ready", last_activity: op.settleAtMs }]);
    expect(
      await queryDO<{ id: string; type: string }>(
        restored,
        "SELECT id, type FROM events WHERE id = ?",
        `capture:${op.id}:released`
      )
    ).toEqual([{ id: `capture:${op.id}:released`, type: "warning" }]);
  });

  /**
   * A due checkpoint whose answer a reset lost, written before its alarm: the
   * reset fell between the operation's write and its schedule.
   */
  async function seedLostCheckpoint(name: string, settleInMs = -1_000) {
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: AUTH_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "snapshotting",
    });
    const now = Date.now();
    await runInSessionDO(stub, (_instance: SessionDO, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE sandbox SET modal_object_id = ?, last_heartbeat = ?",
        "provider-object",
        now
      );
    });
    const op = {
      id: crypto.randomUUID(),
      kind: "checkpoint",
      reason: "execution_complete",
      after: "continue",
      attempt: 1,
      deadlineAtMs: now + settleInMs - 30_000,
      settleAtMs: now + settleInMs,
    };
    await seedShutdown(stub, {
      generationReady: true,
      runtimeReady: true,
      lifecyclePolicy: "confirmed",
      protocolVersion: 1,
      providerObjectId: "provider-object",
      checkpointInFlight: true,
      captureOp: op,
    });
    await runInSessionDO(stub, async (_instance: SessionDO, durableState) => {
      durableState.storage.sql.exec("DELETE FROM session_alarm_state");
      await durableState.storage.deleteAlarm();
    });
    await expect(
      runInSessionDO(stub, (_instance: SessionDO, durableState) => {
        durableState.abort("test: reset before the settle alarm");
      })
    ).rejects.toThrow();
    return { restored: env.SESSION.get(env.SESSION.idFromName(name)), op };
  }

  async function participantOf(stub: DurableObjectStub): Promise<string> {
    const response = await stub.fetch("http://internal/internal/ws-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: "user-1", canonicalUserId: "user-1" }),
    });
    return (await response.json<{ participantId: string }>()).participantId;
  }

  async function expectReleased(stub: DurableObjectStub, opId: string) {
    const record = await readShutdown(stub);
    expect(record).toMatchObject({ phase: "running", checkpointInFlight: false });
    expect(record).not.toHaveProperty("captureOp");
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "ready" },
    ]);
    expect(
      await queryDO<{ id: string }>(
        stub,
        "SELECT id FROM events WHERE id = ?",
        `capture:${opId}:released`
      )
    ).toHaveLength(1);
  }

  it("settles in an alarm that wakes the replacement instance, then keeps watching it", async () => {
    const { restored, op } = await seedLostCheckpoint(`checkpoint-alarm-first-${Date.now()}`);
    // Alarm-first activation initializes without the start-up re-arm. A
    // future alarm is run explicitly; a due one would fire on its own.
    await runInSessionDO(restored, (_instance: SessionDO, durableState) =>
      durableState.storage.setAlarm(Date.now() + 60_000)
    );

    await expect(runDurableObjectAlarm(restored)).resolves.toBe(true);

    await expectReleased(restored, op.id);
    const nextAlarm = await runInSessionDO(restored, (_instance: SessionDO, durableState) =>
      durableState.storage.getAlarm()
    );
    // The watchdog's own next check, not just the later drain deadline.
    expect(nextAlarm).toBeGreaterThan(Date.now());
    expect(nextAlarm).toBeLessThan((await readShutdown(restored)).drainAtMs as number);
  });

  it("re-arms on start-up after a reset before scheduling, then wakes the queued prompt", async () => {
    const { restored, op } = await seedLostCheckpoint(
      `checkpoint-http-first-${Date.now()}`,
      60_000
    );
    // The first request initializes the replacement with the start-up re-arm.
    const authorId = await participantOf(restored);
    await seedMessage(restored, {
      id: "queued-autofix",
      authorId,
      content: "Fix the failing check",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });
    await runInSessionDO(restored, async (instance: SessionDO, durableState) => {
      vi.spyOn(componentsOf(instance).messageQueue, "processMessageQueue").mockResolvedValue(
        undefined
      );
      await vi.waitFor(async () =>
        expect(await durableState.storage.getAlarm()).toBe(op.settleAtMs)
      );
      // Its settle time arrives.
      const record = new SandboxShutdownRepository(durableState.storage.sql).read()!;
      new SandboxShutdownRepository(durableState.storage.sql).write({
        ...record,
        captureOp: { ...record.captureOp!, settleAtMs: Date.now() - 1_000 },
      });
    });

    await expect(runDurableObjectAlarm(restored)).resolves.toBe(true);

    await expectReleased(restored, op.id);
    const woken = await runInSessionDO(
      restored,
      (instance: SessionDO) =>
        vi.mocked(componentsOf(instance).messageQueue.processMessageQueue).mock.calls.length
    );
    expect(woken).toBeGreaterThan(0);
  });

  it("keeps holding a runtime that reported a fatal error during the hold", async () => {
    const { restored } = await seedLostCheckpoint(`checkpoint-fatal-${Date.now()}`, 60_000);
    await runInSessionDO(restored, async (instance: SessionDO, durableState) => {
      await expect(
        componentsOf(instance).lifecycleManager.terminateFailedSandbox("runtime crashed")
      ).resolves.toBe(false);
      // Its settle time arrives while the heartbeat is still recent.
      const store = new SandboxShutdownRepository(durableState.storage.sql);
      const record = store.read()!;
      store.write({
        ...record,
        captureOp: { ...record.captureOp!, settleAtMs: Date.now() - 1_000 },
      });
      await durableState.storage.setAlarm(Date.now() + 60_000);
    });

    await expect(runDurableObjectAlarm(restored)).resolves.toBe(true);

    expect(await readShutdown(restored)).toMatchObject({ phase: "unknown" });
    expect(await queryDO<{ status: string }>(restored, "SELECT status FROM sandbox")).not.toEqual([
      { status: "ready" },
    ]);
  });

  it("does not wake queued work for a runtime whose heartbeat the watchdog finds stale", async () => {
    const name = `checkpoint-stale-redrive-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID, status: "ready" });
    await runInSessionDO(stub, (_instance: SessionDO, durableState) => {
      durableState.storage.sql.exec(
        "UPDATE sandbox SET modal_object_id = ?, last_heartbeat = ?, last_activity = ?",
        "provider-object",
        Date.now() - 10 * 60_000,
        Date.now()
      );
    });
    await seedShutdown(stub, {
      generationReady: true,
      runtimeReady: true,
      lifecyclePolicy: "confirmed",
      protocolVersion: 1,
      providerObjectId: "provider-object",
    });
    await seedMessage(stub, {
      id: "queued",
      authorId: await participantOf(stub),
      content: "Next prompt",
      source: "web",
      status: "pending",
      createdAt: Date.now(),
    });
    await runInSessionDO(stub, async (instance: SessionDO, durableState) => {
      vi.spyOn(componentsOf(instance).messageQueue, "processMessageQueue").mockResolvedValue(
        undefined
      );
      await durableState.storage.setAlarm(Date.now() + 60_000);
    });

    await expect(runDurableObjectAlarm(stub)).resolves.toBe(true);

    const woken = await runInSessionDO(
      stub,
      (instance: SessionDO) =>
        vi.mocked(componentsOf(instance).messageQueue.processMessageQueue).mock.calls.length
    );
    expect(woken).toBe(0);
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).not.toEqual([
      { status: "ready" },
    ]);
  });
});
