import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDO } from "../../src/cloudflare/durable-object";
import {
  DEFAULT_LIFECYCLE_CONFIG,
  SandboxLifecycleManager,
} from "../../src/sandbox/lifecycle/manager";
import type { RestoreConfig, RestoreResult, SandboxProvider } from "../../src/sandbox/provider";
import { EventRepository } from "../../src/session/event-repository";
import { LifecycleSessionContext } from "../../src/session/sandbox-lifecycle-adapters";
import { SandboxRuntimeEventHandler } from "../../src/session/sandbox-events/runtime.handler";
import { SandboxPreservation } from "../../src/session/sandbox-preservation";
import {
  SandboxPreservationRepository,
  type PreservationStore,
} from "../../src/session/sandbox-preservation-repository";
import { SessionCoreRepository } from "../../src/session/session-core-repository";
import { cleanD1Tables } from "./cleanup";
import {
  collectMessages,
  initNamedSession,
  openSandboxWs,
  queryDO,
  seedMessage,
  seedSandboxAuth,
} from "./helpers";
import { componentsOf, runInSessionDO } from "./session-do-access";

const AUTH_TOKEN = "preservation-integration-token";
const SANDBOX_ID = "preservation-sandbox";

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

interface SandboxGeneration {
  sandboxId: string;
  createdAt: number;
}

async function seedPreservation(
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

async function readPreservation(stub: DurableObjectStub): Promise<Record<string, unknown>> {
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
    store?: PreservationStore;
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
  const preservationAnnouncements: object[] = [];
  const lifecycleAnnouncements: object[] = [];
  const queueAdmissions: string[] = [];
  const processQueue = async () => {
    const decision = preservation.admissionDecision();
    queueAdmissions.push(decision);
    options.onQueueAdmission?.(decision);
  };
  const preservation = new SandboxPreservation({
    store: options.store ?? new SandboxPreservationRepository(durableState.storage.sql),
    provider,
    sandbox,
    session: sessions,
    messages: { getProcessingMessage: () => null },
    failures: { record: () => undefined, deliver: () => undefined },
    messenger: {
      broadcast: (message: object) => preservationAnnouncements.push(message),
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
    processQueue,
    reconcileStatus: async () => undefined,
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
    {
      ...DEFAULT_LIFECYCLE_CONFIG,
      controlPlaneUrl: "https://control-plane.test",
      model: "anthropic/claude-sonnet-4-5",
    }
  );
  manager.setPreservation(preservation);
  return {
    manager,
    preservation,
    preservationAnnouncements,
    lifecycleAnnouncements,
    queueAdmissions,
    processQueue,
    sandbox,
    sessions,
  };
}

describe("sandbox preservation wiring", () => {
  it("rolls back the sandbox reservation when the matching preservation write fails", async () => {
    const { stub } = await initNamedSession(`preservation-reservation-rollback-${Date.now()}`);
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
    await seedPreservation(stub, {
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
    const preservationBefore = await readPreservation(stub);

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
      const realStore = new SandboxPreservationRepository(durableState.storage.sql);
      const throwingStore: PreservationStore = {
        read: () => realStore.read(),
        write: () => {
          throw new Error("injected preservation write failure");
        },
      };
      const harness = realLifecycleHarness(instance, durableState, provider, {
        store: throwingStore,
      });

      await harness.manager.spawnSandbox();
      return {
        preservationAnnouncements: harness.preservationAnnouncements,
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
    expect(await readPreservation(stub)).toEqual(preservationBefore);
    expect(result.preservationAnnouncements).toEqual([]);
    expect(result.lifecycleAnnouncements).not.toContainEqual({
      type: "sandbox_status",
      status: "spawning",
    });
  });

  it("accepts early ready for a saved restore but gates the queue until provider lifetime settles", async () => {
    const { stub } = await initNamedSession(`preservation-early-ready-${Date.now()}`);
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
    await seedPreservation(stub, {
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
        harness.manager,
        {
          ready: (version) => harness.preservation.runtimeReady(version),
          isHolding: () => harness.preservation.isHolding(),
        }
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
    expect(evidence.queueAdmissions.slice(0, -1)).toEqual(["held", "held"]);
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
    expect(await readPreservation(stub)).toMatchObject({
      phase: "running",
      runtimeReady: true,
      providerObjectId: "restored-provider-object",
    });
  });

  it("rejects push from saved state when no live sandbox is available", async () => {
    const { stub } = await initNamedSession(`preservation-saved-push-${Date.now()}`);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    await seedPreservation(stub, {
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
    const { stub } = await initNamedSession(`preservation-unmanaged-${Date.now()}`);
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
        {
          ...DEFAULT_LIFECYCLE_CONFIG,
          controlPlaneUrl: "https://control-plane.test",
          model: "anthropic/claude-sonnet-4-5",
        }
      );
      const preservation = new SandboxPreservation({
        store: new SandboxPreservationRepository(durableState.storage.sql),
        provider,
        sandbox,
        background: {
          submit: (task: () => Promise<void>) => {
            void task();
          },
        },
        processQueue: async () => undefined,
      } as never);
      manager.setPreservation(preservation);

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
    const name = `preservation-generation-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    const generation = await seedPreservation(stub);
    const [{ id: authorId }] = await queryDO<{ id: string }>(
      stub,
      "SELECT id FROM participants LIMIT 1"
    );
    await seedMessage(stub, {
      id: "preservation-pending",
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
        "preservation-pending"
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
      expect.objectContaining({ type: "prompt", messageId: "preservation-pending" })
    );
    ws!.close();
  });

  it("dispatches restored legacy work when ready omits the preservation protocol", async () => {
    const name = `preservation-legacy-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, {
      authToken: AUTH_TOKEN,
      sandboxId: SANDBOX_ID,
      status: "connecting",
    });
    await seedPreservation(stub, {
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
    expect(await readPreservation(stub)).toMatchObject({
      phase: "running",
      lifecyclePolicy: "legacy",
      runtimeReady: true,
    });
    expect(await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox")).toEqual([
      { status: "ready" },
    ]);
    ws!.close();
  });

  it("drains once, holds pending work, and acknowledges only matching preparation state", async () => {
    const name = `preservation-drain-${Date.now()}`;
    const { stub } = await initNamedSession(name);
    await seedSandboxAuth(stub, { authToken: AUTH_TOKEN, sandboxId: SANDBOX_ID });
    const generation = await seedPreservation(stub, {
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
      id: "preservation-processing",
      authorId,
      content: "Stop before preservation",
      source: "web",
      status: "processing",
      createdAt: Date.now() - 2_000,
      startedAt: Date.now() - 1_000,
    });
    await seedMessage(stub, {
      id: "preservation-held",
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
      messageId: "preservation-processing",
      operationId: expect.any(String),
    });
    expect(
      await queryDO<{ id: string; status: string }>(
        stub,
        "SELECT id, status FROM messages WHERE id IN (?, ?) ORDER BY id",
        "preservation-processing",
        "preservation-held"
      )
    ).toEqual([
      { id: "preservation-held", status: "pending" },
      { id: "preservation-processing", status: "failed" },
    ]);
    await runInSessionDO(stub, (instance: SessionDO) => instance.alarm());
    expect(
      await queryDO<{ count: number }>(
        stub,
        "SELECT COUNT(*) AS count FROM events WHERE type = 'execution_complete' AND message_id = ?",
        "preservation-processing"
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
    expect(await readPreservation(stub)).toMatchObject({ phase: "draining" });

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
    expect(await readPreservation(stub)).toMatchObject({ phase: "failed" });
    ws!.close();
  });
});
