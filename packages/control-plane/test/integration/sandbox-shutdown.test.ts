import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:test";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  SandboxLifecycleManager,
} from "../../src/sandbox/lifecycle/manager";
import type { RestoreConfig, RestoreResult, SandboxProvider } from "../../src/sandbox/provider";
import { EventRepository } from "../../src/session/event-repository";
import { MessageFailureService } from "../../src/session/message-failure-service";
import { MessageRepository } from "../../src/session/message-repository";
import { LifecycleSessionContext } from "../../src/session/sandbox-lifecycle-adapters";
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

function realLifecycleHarness(
  instance: SessionDO,
  durableState: DurableObjectState,
  provider: SandboxProvider,
  options: {
    store?: ShutdownStore;
    onQueueAdmission?: (decision: string) => void;
  } = {}
) {
  const sandbox = componentsOf(instance).sandboxRepository;
  const sessions = new SessionCoreRepository(durableState.storage.sql, (callback) =>
    durableState.storage.transactionSync(callback)
  );
  const sessionContext = new LifecycleSessionContext(sessions, {
    getUserEnvVars: async () => undefined,
  } as never);
  const shutdownAnnouncements: object[] = [];
  const lifecycleAnnouncements: object[] = [];
  const queueAdmissions: string[] = [];
  const processQueue = async () => {
    const decision = shutdown.admissionDecision();
    queueAdmissions.push(decision);
    options.onQueueAdmission?.(decision);
  };
  const shutdown = new SandboxShutdownCoordinator({
    store: options.store ?? new SandboxShutdownRepository(durableState.storage.sql),
    provider,
    sandbox,
    session: sessions,
    messages: { getProcessingMessage: () => null },
    failures: { record: () => undefined, deliver: () => undefined },
    messenger: {
      broadcast: (message: object) => shutdownAnnouncements.push(message),
    },
    sockets: {
      getSandboxSocket: () => null,
      send: () => false,
    },
    alarm: { schedule: async () => undefined },
    background: {
      submit: (task: () => Promise<void>) => {
        void task();
      },
    },
    onLifecycleChange: processQueue,
    reconcileStatusFromMessages: async () => undefined,
    retireAccess: () => undefined,
  } as never);
  const manager = new SandboxLifecycleManager(
    provider,
    sandbox,
    sessionContext,
    { broadcast: (message) => lifecycleAnnouncements.push(message) },
    {
      getSandboxWebSocket: () => null,
      getConnectedClientCount: () => 0,
      sendToSandbox: () => false,
      detachSandboxWebSocket: () => undefined,
    },
    {
      schedule: async () => undefined,
      cancel: async () => undefined,
      current: async () => null,
    },
    { generateId: () => "integration-sandbox-token" },
    shutdown,
    {
      ...DEFAULT_LIFECYCLE_CONFIG,
      controlPlaneUrl: "https://control-plane.test",
      model: "anthropic/claude-sonnet-4-5",
    }
  );
  return {
    manager,
    shutdown,
    shutdownAnnouncements,
    lifecycleAnnouncements,
    queueAdmissions,
    processQueue,
    sandbox,
    sessions,
  };
}

describe("sandbox graceful shutdown wiring", () => {
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
          snapshotStopsSandbox: true,
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
      const shutdown = new SandboxShutdownCoordinator({
        store: new SandboxShutdownRepository(durableState.storage.sql),
        provider,
        sandbox,
        session: {
          getSession: () => ({ id: "session-1", session_name: "legacy-session" }),
        },
        messenger: { broadcast: () => undefined },
        background: {
          submit: (task: () => Promise<void>) => {
            void task();
          },
        },
        onLifecycleChange: async () => undefined,
        retireAccess: () => undefined,
      } as never);
      const manager = new SandboxLifecycleManager(
        provider,
        sandbox,
        {
          getSession: () => ({ id: "session-1", session_name: "legacy-session" }),
          getSessionRepositories: () => [],
          getUserEnvVars: async () => undefined,
        } as never,
        { broadcast: () => undefined },
        {
          getConnectedClientCount: () => 0,
          sendToSandbox: () => false,
          detachSandboxWebSocket: () => undefined,
        } as never,
        { schedule: async () => undefined, cancel: async () => undefined } as never,
        { generateId: () => "generated-id" },
        shutdown,
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
    await vi.waitFor(async () => {
      expect(await readShutdown(stub)).not.toMatchObject({ continuationPaused: true });
    });
    const rejected = collectMessages(authenticated.ws, {
      until: (message) => message.type === "error",
    });
    authenticated.ws.send(
      JSON.stringify({
        type: "recover_preservation",
        action: "restore_saved",
        clientRequestId: "stale-1",
      })
    );
    await expect(rejected).resolves.toContainEqual({
      type: "error",
      code: "RECOVERY_UNAVAILABLE",
      message: "Shutdown recovery is unavailable",
      clientRequestId: "stale-1",
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
