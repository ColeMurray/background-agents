import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, seedSandboxAuth, seedMessage, queryDO, serviceFetch } from "./helpers";
import { env } from "cloudflare:test";
import { DEFAULT_LIFECYCLE_CONFIG } from "../../src/sandbox/lifecycle/manager";
import { runInSessionDO, componentsOf } from "./session-do-access";
import { realLifecycleHarness } from "./sandbox-lifecycle-harness";
import type { SandboxProvider } from "../../src/sandbox/provider";
import { SandboxShutdownRepository } from "../../src/session/sandbox-shutdown-repository";
import { EventRepository } from "../../src/session/event-repository";
import { createAlarmHandler } from "../../src/session/alarm/handler";
import { createLogger } from "../../src/logger";
import { EXPIRY_CONTINUATION_PROMPT } from "../../src/session/expiry-continuation";

beforeEach(cleanD1Tables);
afterEach(cleanD1Tables);

it.each([
  "active",
  "stalled",
  "cancelled",
  "connecting-timeout",
  "boot-budget",
  "stale-heartbeat",
  "single-task",
  "snapshot-order",
])("expiry handoff handles %s durably", async (scenario) => {
  const hasProgress = scenario !== "stalled";
  const name = `automatic-expiry-${scenario}-${Date.now()}`;
  const { stub } = await initNamedSession(name);
  await seedSandboxAuth(stub, {
    sandboxId: "source",
    authToken: "expiry-token",
    status: "ready",
  });
  const [{ id: authorId }] = await queryDO<{ id: string }>(
    stub,
    "SELECT id FROM participants LIMIT 1"
  );
  const now = Date.now();
  await seedMessage(stub, {
    id: "interrupted",
    authorId,
    content: "Original task",
    source: "web",
    status: "processing",
    createdAt: now - 60_000,
    startedAt: now - 60_000,
  });
  if (scenario !== "single-task")
    await seedMessage(stub, {
      id: "queued",
      authorId,
      content: "Later user request",
      source: "web",
      status: "pending",
      createdAt: now - 30_000,
    });
  const createSandbox = vi.fn(async () => {
    throw new Error("must restore the saved workspace");
  });
  const restoreFromSnapshot = vi.fn<NonNullable<SandboxProvider["restoreFromSnapshot"]>>(
    async (config) => ({
      success: true,
      sandboxId: config.sandboxId,
      providerObjectId: "restored-object",
      lifetime: {
        kind: "finite",
        expiresAtMs: Date.now() + 7_200_000,
        observedAtMs: Date.now(),
        source: "provider",
      },
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
    createSandbox,
    stopSandbox: vi.fn(async () => ({ success: true })),
    restoreFromSnapshot,
    takeSnapshot: vi.fn(async () => ({
      success: true,
      imageId: "context-snapshot",
      sourceStopped: true,
    })),
  };

  const evidence = await runInSessionDO(stub, async (instance, durableState) => {
    const sql = durableState.storage.sql;
    sql.exec(
      "UPDATE session SET sandbox_settings = ?",
      JSON.stringify({ autoContinueOnExpiry: true })
    );
    sql.exec(
      "UPDATE sandbox SET modal_object_id = ?, runtime_version = ?, last_heartbeat = ?",
      "source-object",
      "v72-runtime",
      now
    );
    const [{ created_at: createdAt }] = sql.exec("SELECT created_at FROM sandbox").toArray() as {
      created_at: number;
    }[];
    const generation = { sandboxId: "source", createdAt };
    const store = new SandboxShutdownRepository(sql);
    store.write({
      phase: "running",
      generation,
      provider: "modal",
      providerObjectId: "source-object",
      lifetimeKind: "finite",
      lifetimeSource: "provider",
      expiresAtMs: now + 600_000,
      drainAtMs: now,
      generationReady: true,
      runtimeReady: true,
      protocolVersion: 1,
      lifecyclePolicy: "confirmed",
    });
    const events = new EventRepository(sql, (callback) =>
      durableState.storage.transactionSync(callback)
    );
    // Heartbeats never qualify as progress. An event from another task does not qualify either.
    events.createEvent({
      id: "heartbeat-proof",
      type: "heartbeat",
      data: "{}",
      messageId: "interrupted",
      createdAt: now,
    });
    events.createEvent({
      id: "other-task",
      type: "tool_call",
      data: "{}",
      messageId: "queued",
      createdAt: now,
    });
    expect(events.hasRecentExecutionProgress("interrupted", now - 600_000, now)).toBe(false);
    if (hasProgress)
      events.createEvent({
        id: "progress-proof",
        type: "token",
        data: "{}",
        messageId: "interrupted",
        createdAt: now,
      });
    const first = realLifecycleHarness(instance, durableState, provider, {
      reconcileStatus: scenario === "single-task",
    });
    await first.shutdown.handleAlarm();
    if (scenario === "single-task") {
      await componentsOf(instance).statusService.reconcileFromMessageState();
      expect(first.sessions.getSession()?.status).toBe("failed");
    }
    first.shutdown.prepared({
      type: "preservation_prepared",
      operationId: store.read()!.operationId!,
      generation,
      executionStopped: true,
      agentSessionId: "saved-conversation",
      sandboxId: "source",
      timestamp: now / 1_000,
    });
    await first.shutdown.handleAlarm();
    await vi.waitFor(() => expect(store.read()?.phase).toBe("saved"));
    const saved = store.read()!;
    expect(saved.phase).toBe("saved");
    if (scenario === "single-task") {
      await vi.waitFor(() => expect(first.sessions.getSession()?.status).toBe("active"));
      expect(
        await env.DB.prepare("SELECT status FROM sessions WHERE id = ?").bind(name).first("status")
      ).toBe("active");
    }
    const reconstructed = realLifecycleHarness(instance, durableState, provider);
    if (scenario === "snapshot-order") {
      expect(reconstructed.messages.getNextPendingMessage()?.id).toBe(
        saved.continuation!.messageId
      );
      expect(
        reconstructed.messages.getUnfinishedMessagePosition(saved.continuation!.messageId)
      ).toBe(1);
      expect(reconstructed.messages.getUnfinishedMessagePosition("queued")).toBe(2);
      expect(reconstructed.messages.listPendingMessagesWithCreatedAt().map((m) => m.id)).toEqual([
        saved.continuation!.messageId,
        "queued",
      ]);
      return { saved, final: store.read() };
    }
    if (!hasProgress) {
      expect(reconstructed.shutdown.admissionDecision()).toBe("held");
      return { saved, final: store.read() };
    }
    expect(reconstructed.shutdown.pendingContinuationMessageId()).toBe(
      saved.continuation!.messageId
    );
    await reconstructed.manager.spawnSandbox();
    const row = reconstructed.sandbox.getSandbox()!;
    const restoredGeneration = { sandboxId: row.modal_sandbox_id!, createdAt: row.created_at };
    expect(reconstructed.shutdown.admissionDecision()).toBe("held");
    if (["connecting-timeout", "boot-budget", "stale-heartbeat"].includes(scenario)) {
      const stopsBeforeAlarm = vi.mocked(provider.stopSandbox!).mock.calls.length;
      const config = DEFAULT_LIFECYCLE_CONFIG;
      const delayMs =
        scenario === "boot-budget"
          ? config.bootBudget.timeoutMs + 1
          : scenario === "connecting-timeout"
            ? config.connectingTimeout.timeoutMs + 1
            : config.heartbeat.timeoutMs + 1;
      const alarmAt = Date.now() + delayMs;
      if (scenario !== "connecting-timeout")
        sql.exec(
          "UPDATE sandbox SET last_heartbeat = ?",
          scenario === "boot-budget" ? alarmAt : Date.now()
        );
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(alarmAt);
      const failPendingMessage = vi.fn(async () => undefined);
      const resumeAfterSandboxTermination = vi.fn(async () => undefined);
      const handler = createAlarmHandler({
        repository: reconstructed.messages,
        lifecycleManager: reconstructed.manager,
        messageQueue: {
          failPendingMessage,
          failStuckProcessingMessage: vi.fn(async () => undefined),
        },
        executionStop: {
          resumeAfterSandboxTermination,
          recoverStopConfirmationTimeout: async () => undefined,
        },
        terminalMessageProjection: { flushPending: async () => undefined },
        alarmScheduler: {
          schedule: async () => undefined,
          cancel: async () => undefined,
          current: async () => null,
        },
        redriveIdleQueue: reconstructed.processQueue,
        getExecutionTimeoutMs: () => 7_200_000,
        now: () => Date.now(),
        log: createLogger("expiry-watchdog-test"),
      });
      try {
        await handler.handle();
      } finally {
        vi.useRealTimers();
      }
      expect(provider.stopSandbox).toHaveBeenCalledTimes(stopsBeforeAlarm);
      expect(failPendingMessage).not.toHaveBeenCalled();
      expect(resumeAfterSandboxTermination).not.toHaveBeenCalled();
      expect(store.read()).toMatchObject({
        phase: "unknown",
        continuationPaused: true,
        receipt: saved.receipt,
      });
      expect(
        sql.exec("SELECT status FROM messages WHERE id = ?", saved.continuation!.messageId).one()
      ).toMatchObject({ status: "failed" });
      const restarted = realLifecycleHarness(instance, durableState, provider);
      expect(restarted.shutdown.admissionDecision()).toBe("held");
      expect(restarted.shutdown.snapshot()?.availableRecoveryActions).toContain("restore_saved");
      expect(await restarted.manager.handleAlarm()).toBe("no_action");
      return { saved, final: store.read() };
    }
    if (scenario === "cancelled") {
      expect(reconstructed.messages.cancelPendingMessage(saved.continuation!.messageId)).toBe(true);
    }
    reconstructed.manager.onRuntimeReady(Date.now(), "opencode", 1, "saved-conversation");
    reconstructed.manager.onShutdownGenerationReady({
      type: "sandbox_generation_ready",
      generation: restoredGeneration,
      sandboxId: restoredGeneration.sandboxId,
      timestamp: Date.now() / 1_000,
    });
    expect(reconstructed.shutdown.admissionDecision()).toBe("ready");
    return { saved, final: store.read() };
  });
  const rows = await queryDO<{ id: string; status: string; content: string }>(
    stub,
    "SELECT id, status, content FROM messages"
  );
  expect(rows.find((row) => row.id === "interrupted")?.status).toBe("failed");
  if (scenario !== "single-task")
    expect(rows.find((row) => row.id === "queued")?.status).toBe("pending");
  if (scenario === "snapshot-order") {
    const response = await serviceFetch(`https://test.local/sessions/${name}`);
    expect(response.status).toBe(200);
    const snapshot = await response.json<{ promptQueue: { messageId: string }[] }>();
    expect(snapshot.promptQueue.map((item) => item.messageId)).toEqual([
      evidence.saved.continuation!.messageId,
      "queued",
    ]);
  }
  expect(rows.filter((row) => row.content === EXPIRY_CONTINUATION_PROMPT)).toHaveLength(
    hasProgress && scenario !== "cancelled" ? 1 : 0
  );
  expect(createSandbox).not.toHaveBeenCalled();
  expect(restoreFromSnapshot).toHaveBeenCalledTimes(
    hasProgress && scenario !== "snapshot-order" ? 1 : 0
  );
  if (["active", "single-task"].includes(scenario))
    expect(evidence.final).toMatchObject({
      automaticHandoffs: 1,
      continuation: { contextVerified: true },
    });
});
