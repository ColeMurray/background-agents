import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { componentsOf, runInSessionDO } from "./session-do-access";
import { cleanD1Tables } from "./cleanup";
import { initNamedSession, openSandboxWs, queryDO, seedMessage, seedSandboxAuth } from "./helpers";
import { MessageRepository } from "../../src/session/message-repository";
import { EventRepository } from "../../src/session/event-repository";
import { SessionAttachmentRepository } from "../../src/session/session-attachment-repository";

const sockets: WebSocket[] = [];

async function connectedSession() {
  const name = `execution-budget-${crypto.randomUUID()}`;
  const { stub } = await initNamedSession(name);
  const sandboxId = `sandbox-${crypto.randomUUID()}`;
  const auth = { sandboxId, authToken: crypto.randomUUID() };
  await seedSandboxAuth(stub, auth);
  const { ws } = await openSandboxWs(name, auth);
  if (!ws) throw new Error("Expected sandbox upgrade");
  ws.accept();
  sockets.push(ws);
  await runInSessionDO(stub, (instance, state) => {
    state.storage.sql.exec(
      `UPDATE sandbox SET runtime_capabilities = ?, last_heartbeat = ?, last_activity = ?`,
      JSON.stringify(["execution-deadline-v1", "stop-confirmation-v1"]),
      Date.now(),
      Date.now()
    );
  });
  const [participant] = await queryDO<{ id: string }>(stub, "SELECT id FROM participants LIMIT 1");
  return { stub, sandboxId, participantId: participant.id };
}

async function queueMessage(stub: DurableObjectStub, participantId: string, id: string) {
  await seedMessage(stub, {
    id,
    authorId: participantId,
    content: "Run a quiet tool",
    source: "web",
    status: "pending",
    createdAt: Date.now(),
  });
}

function terminal(messageId: string, sandboxId: string, executionStopped?: boolean) {
  return {
    type: "execution_complete" as const,
    messageId,
    sandboxId,
    success: false,
    timestamp: Date.now() / 1000,
    ...(executionStopped === undefined ? {} : { executionStopped }),
  };
}

describe("durable execution deadline and cessation boundary", () => {
  beforeEach(cleanD1Tables);
  afterEach(() => {
    vi.restoreAllMocks();
    for (const socket of sockets.splice(0)) socket.close();
  });

  it("expires never-dispatched automation admission through the persisted session alarm", async () => {
    const { stub, participantId } = await connectedSession();
    await queueMessage(stub, participantId, "admission-expired");
    await runInSessionDO(stub, async (instance, state) => {
      const c = componentsOf(instance);
      const deadline = Date.now() + 1000;
      state.storage.sql.exec(
        "UPDATE messages SET callback_context = ? WHERE id = 'admission-expired'",
        JSON.stringify({
          source: "automation",
          automationId: "automation",
          runId: "run",
          executionLaunchId: "launch",
          admissionDeadlineMs: deadline,
        })
      );
      await c.messageQueue.expirePendingAdmissions();
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(deadline);
      const clock = vi.spyOn(Date, "now").mockReturnValue(deadline);
      try {
        await instance.alarm();
        expect(
          await c.messageQueue.reconcileExecutionState("run", "launch", deadline)
        ).toMatchObject({
          executionState: "idle",
          messageStatus: "failed",
          launchAdmissionExpired: true,
          launch: {
            messageId: "admission-expired",
            status: "failed",
            error: expect.stringContaining("startup deadline"),
          },
        });
      } finally {
        clock.mockRestore();
      }
      expect(
        state.storage.sql
          .exec(
            "SELECT status, started_at, execution_deadline_ms, stop_confirmation_deadline FROM messages WHERE id = 'admission-expired'"
          )
          .one()
      ).toEqual({
        status: "failed",
        started_at: null,
        execution_deadline_ms: null,
        stop_confirmation_deadline: null,
      });
    });
  });

  it("persists the first dispatch budget through repository reconstruction and a dispatch retry", async () => {
    const { stub, participantId } = await connectedSession();
    await queueMessage(stub, participantId, "retry-turn");
    const result = await runInSessionDO(stub, async (instance, state) => {
      const queue = componentsOf(instance).messageQueue;
      await queue.processMessageQueue();
      const first = state.storage.sql
        .exec<{
          started_at: number;
          execution_deadline_ms: number;
          cleanup_deadline_ms: number;
        }>(
          "SELECT started_at, execution_deadline_ms, cleanup_deadline_ms FROM messages WHERE id = 'retry-turn'"
        )
        .one();
      const transaction = <T>(closure: () => T) => state.storage.transactionSync(closure);
      const repository = new MessageRepository(
        state.storage.sql,
        transaction,
        new SessionAttachmentRepository(state.storage.sql),
        new EventRepository(state.storage.sql, transaction)
      );
      repository.updateMessageToPending("retry-turn");
      // Settings and provider renewals may change while a dispatch is retried.
      state.storage.sql.exec(
        "UPDATE session SET sandbox_settings = ?",
        JSON.stringify({ sandboxTimeoutMs: 14_400_000 })
      );
      const clock = vi.spyOn(Date, "now").mockReturnValue(first.started_at + 60_000);
      try {
        await queue.processMessageQueue();
      } finally {
        clock.mockRestore();
      }
      const second = state.storage.sql
        .exec(
          "SELECT started_at, execution_deadline_ms, cleanup_deadline_ms FROM messages WHERE id = 'retry-turn'"
        )
        .one();
      return { first, second };
    });
    expect(result.first.execution_deadline_ms - result.first.started_at).toBe(6_300_000);
    expect(result.first.cleanup_deadline_ms - result.first.execution_deadline_ms).toBe(900_000);
    expect(result.second).toEqual(result.first);
  });

  it("waits for provider expiry initialization and refuses exhausted known lifetime", async () => {
    const { stub, participantId } = await connectedSession();
    await queueMessage(stub, participantId, "exhausted-turn");
    await runInSessionDO(stub, async (instance, state) => {
      const queue = componentsOf(instance).messageQueue;
      state.storage.sql.exec("UPDATE sandbox SET provider_execution_expiry_kind = NULL");
      await queue.processMessageQueue();
      expect(
        state.storage.sql.exec("SELECT status FROM messages WHERE id = 'exhausted-turn'").one()
      ).toEqual({ status: "pending" });
      state.storage.sql.exec(
        "UPDATE sandbox SET provider_execution_expiry_kind = 'hard', provider_execution_expires_at_ms = ?",
        Date.now() + 60_000
      );
      await queue.processMessageQueue();
    });
    const [message] = await queryDO<{
      status: string;
      error_message: string;
      started_at: number | null;
    }>(stub, "SELECT status, error_message, started_at FROM messages WHERE id = 'exhausted-turn'");
    expect(message.status).toBe("failed");
    expect(message.error_message).toContain("runtime refresh is required");
    expect(message.started_at).toBeNull();
    expect((await queryDO<{ status: string }>(stub, "SELECT status FROM sandbox"))[0].status).toBe(
      "ready"
    );
  });

  it("cannot delete the stop fence by cancelling a failed-dispatch pending prompt", async () => {
    const { stub, participantId } = await connectedSession();
    await queueMessage(stub, participantId, "failed-dispatch");
    await runInSessionDO(stub, async (instance, state) => {
      const c = componentsOf(instance);
      const send = vi.spyOn(c.wsManager, "send").mockReturnValue(false);
      const terminate = vi
        .spyOn(c.lifecycleManager, "terminateUnresponsiveSandbox")
        .mockResolvedValue(false);
      await c.messageQueue.processMessageQueue();
      send.mockRestore();
      terminate.mockRestore();
      const transaction = <T>(closure: () => T) => state.storage.transactionSync(closure);
      const repository = new MessageRepository(
        state.storage.sql,
        transaction,
        new SessionAttachmentRepository(state.storage.sql),
        new EventRepository(state.storage.sql, transaction)
      );
      expect(repository.cancelPendingMessage("failed-dispatch")).toBe(false);
      expect(repository.getMessageAwaitingStopConfirmation()?.id).toBe("failed-dispatch");
      expect(
        state.storage.sql.exec("SELECT status FROM messages WHERE id = 'failed-dispatch'").one()
      ).toEqual({ status: "pending" });
    });
  });

  it("caps dispatch against the provider expiry and shares that cap with cleanup", async () => {
    const { stub, participantId } = await connectedSession();
    await queueMessage(stub, participantId, "provider-cap");
    const result = await runInSessionDO(stub, async (instance, state) => {
      const expiry = Date.now() + 1_000_000;
      state.storage.sql.exec(
        "UPDATE sandbox SET provider_execution_expiry_kind = 'conservative', provider_execution_expires_at_ms = ?",
        expiry
      );
      await componentsOf(instance).messageQueue.processMessageQueue();
      return {
        expiry,
        row: state.storage.sql
          .exec(
            "SELECT execution_deadline_ms, cleanup_deadline_ms FROM messages WHERE id = 'provider-cap'"
          )
          .one(),
      };
    });
    expect(result.row).toEqual({
      execution_deadline_ms: result.expiry - 900_000,
      cleanup_deadline_ms: result.expiry,
    });
  });

  it("expires through Stop, keeps failure fenced after provider failure, and requires correlated cessation", async () => {
    const { stub, participantId, sandboxId } = await connectedSession();
    await queueMessage(stub, participantId, "expired");
    await queueMessage(stub, participantId, "next");
    await runInSessionDO(stub, async (instance, state) => {
      const c = componentsOf(instance);
      await c.messageQueue.processMessageQueue();
      state.storage.sql.exec(
        "UPDATE messages SET execution_deadline_ms = ? WHERE id = 'expired'",
        Date.now() - 1
      );
      await instance.alarm();
      let first = state.storage.sql
        .exec<{
          status: string;
          error_message: string;
          stop_confirmation_deadline: number;
        }>(
          "SELECT status, error_message, stop_confirmation_deadline FROM messages WHERE id = 'expired'"
        )
        .one();
      expect(first.status).toBe("failed");
      expect(first.error_message).toBe("Execution deadline exceeded");
      expect(first.stop_confirmation_deadline).toBeTypeOf("number");
      state.storage.sql.exec(
        "UPDATE messages SET stop_confirmation_deadline = ? WHERE id = 'expired'",
        Date.now() - 1
      );
      const terminate = vi
        .spyOn(c.lifecycleManager, "terminateUnresponsiveSandbox")
        .mockResolvedValue(false);
      await instance.alarm();
      terminate.mockRestore();
      await c.sandboxEventProcessor.processSandboxEvent(terminal("expired", sandboxId));
      await c.sandboxEventProcessor.processSandboxEvent(terminal("expired", "old-sandbox", true));
      expect(state.storage.sql.exec("SELECT status FROM messages WHERE id = 'next'").one()).toEqual(
        { status: "pending" }
      );
      first = state.storage.sql
        .exec<
          typeof first
        >("SELECT status, error_message, stop_confirmation_deadline FROM messages WHERE id = 'expired'")
        .one();
      expect(first.stop_confirmation_deadline).toBeTypeOf("number");
      await c.sandboxEventProcessor.processSandboxEvent(terminal("expired", sandboxId, true));
      expect(state.storage.sql.exec("SELECT status FROM messages WHERE id = 'next'").one()).toEqual(
        { status: "processing" }
      );
      expect(
        state.storage.sql
          .exec(
            "SELECT error_message, stop_confirmation_deadline FROM messages WHERE id = 'expired'"
          )
          .one()
      ).toEqual({ error_message: "Execution deadline exceeded", stop_confirmation_deadline: null });
    });
  });

  it("contains abnormal completion without evidence instead of snapshotting or reusing the runtime", async () => {
    const { stub, participantId, sandboxId } = await connectedSession();
    await queueMessage(stub, participantId, "broken-stream");
    await queueMessage(stub, participantId, "blocked-next");
    await runInSessionDO(stub, async (instance, state) => {
      const c = componentsOf(instance);
      await c.messageQueue.processMessageQueue();
      const snapshot = vi.spyOn(c.lifecycleManager, "triggerSnapshot").mockResolvedValue();
      await c.sandboxEventProcessor.processSandboxEvent(
        terminal("broken-stream", sandboxId, false)
      );
      expect(snapshot).not.toHaveBeenCalled();
      expect(
        state.storage.sql.exec("SELECT status FROM messages WHERE id = 'blocked-next'").one()
      ).toEqual({ status: "pending" });
      expect(
        state.storage.sql
          .exec<{
            stop_confirmation_deadline: number;
          }>("SELECT stop_confirmation_deadline FROM messages WHERE id = 'broken-stream'")
          .one().stop_confirmation_deadline
      ).toBeTypeOf("number");
    });
  });

  it("starts a single persisted cleanup interval on early Stop without renewing it on duplicates", async () => {
    const { stub, participantId, sandboxId } = await connectedSession();
    await queueMessage(stub, participantId, "early-stop");
    await runInSessionDO(stub, async (instance, state) => {
      state.storage.sql.exec(
        "UPDATE session SET sandbox_settings = ?",
        JSON.stringify({ sandboxTimeoutMs: 600_000 })
      );
      const c = componentsOf(instance);
      await c.messageQueue.processMessageQueue();
      const start = Date.now();
      await c.sandboxEventProcessor.processSandboxEvent(terminal("early-stop", sandboxId, false));
      const first = state.storage.sql
        .exec<{
          cleanup_deadline_ms: number;
          cleanup_reserve_ms: number;
        }>("SELECT cleanup_deadline_ms, cleanup_reserve_ms FROM messages WHERE id = 'early-stop'")
        .one();
      expect(first.cleanup_reserve_ms).toBe(150_000);
      expect(first.cleanup_deadline_ms).toBeLessThanOrEqual(Date.now() + first.cleanup_reserve_ms);
      expect(first.cleanup_deadline_ms).toBeGreaterThanOrEqual(start + first.cleanup_reserve_ms);
      const clock = vi.spyOn(Date, "now").mockReturnValue(start + 10_000);
      try {
        await c.sandboxEventProcessor.processSandboxEvent(terminal("early-stop", sandboxId, false));
      } finally {
        clock.mockRestore();
      }
      expect(
        state.storage.sql
          .exec(
            "SELECT cleanup_deadline_ms, cleanup_reserve_ms FROM messages WHERE id = 'early-stop'"
          )
          .one()
      ).toEqual(first);
    });
  });

  it("does not release a newer stop fence when an older provider termination resolves late", async () => {
    const { stub, participantId, sandboxId } = await connectedSession();
    await queueMessage(stub, participantId, "older-stop");
    await queueMessage(stub, participantId, "newer-stop");
    await runInSessionDO(stub, async (instance, state) => {
      const c = componentsOf(instance);
      await c.messageQueue.processMessageQueue();
      await c.sandboxEventProcessor.processSandboxEvent(terminal("older-stop", sandboxId, false));
      state.storage.sql.exec(
        "UPDATE messages SET stop_confirmation_deadline = ? WHERE id = 'older-stop'",
        Date.now() - 1
      );
      let resolveTermination!: (confirmed: boolean) => void;
      let terminationStarted!: () => void;
      const entered = new Promise<void>((resolve) => {
        terminationStarted = resolve;
      });
      const terminate = vi
        .spyOn(c.lifecycleManager, "terminateUnresponsiveSandbox")
        .mockImplementation(() => {
          terminationStarted();
          return new Promise<boolean>((resolve) => {
            resolveTermination = resolve;
          });
        });
      const recovering = instance.alarm();
      await entered;
      await c.sandboxEventProcessor.processSandboxEvent(terminal("older-stop", sandboxId, true));
      await c.sandboxEventProcessor.processSandboxEvent(terminal("newer-stop", sandboxId, false));
      resolveTermination(true);
      await recovering;
      terminate.mockRestore();
      expect(
        state.storage.sql
          .exec<{
            stop_confirmation_deadline: number;
          }>("SELECT stop_confirmation_deadline FROM messages WHERE id = 'newer-stop'")
          .one().stop_confirmation_deadline
      ).toBeTypeOf("number");
    });
  });

  it("does not grant another cleanup allowance after the runtime consumed its reserve", async () => {
    const { stub, participantId, sandboxId } = await connectedSession();
    await queueMessage(stub, participantId, "runtime-cleanup-expired");
    await runInSessionDO(stub, async (instance, state) => {
      const c = componentsOf(instance);
      await c.messageQueue.processMessageQueue();
      const consumedCleanupDeadline = Date.now() - 1;
      await c.sandboxEventProcessor.processSandboxEvent({
        ...terminal("runtime-cleanup-expired", sandboxId, false),
        cleanupDeadlineMs: consumedCleanupDeadline,
      });
      expect(
        state.storage.sql
          .exec("SELECT cleanup_deadline_ms FROM messages WHERE id = 'runtime-cleanup-expired'")
          .one()
      ).toEqual({ cleanup_deadline_ms: consumedCleanupDeadline });
    });
  });

  it("retains a healthy quiet turn beyond idle timeout and also protects unresolved cancellation", async () => {
    const { stub, participantId, sandboxId } = await connectedSession();
    await queueMessage(stub, participantId, "quiet-turn");
    await runInSessionDO(stub, async (instance, state) => {
      const c = componentsOf(instance);
      await c.messageQueue.processMessageQueue();
      let now = Date.now();
      const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
      const snapshot = vi.spyOn(c.lifecycleManager, "triggerSnapshot").mockResolvedValue();
      try {
        for (let i = 0; i < 22; i++) {
          now += 30_000;
          await c.sandboxEventProcessor.processSandboxEvent({
            type: "heartbeat",
            sandboxId,
            status: "running",
            timestamp: now / 1000,
          });
        }
        await instance.alarm();
        expect(
          state.storage.sql.exec("SELECT status FROM messages WHERE id = 'quiet-turn'").one()
        ).toEqual({ status: "processing" });
        expect(state.storage.sql.exec("SELECT last_activity FROM sandbox").one()).toEqual({
          last_activity: now,
        });
        expect(snapshot).not.toHaveBeenCalled();
        // The reporting row is terminal now, but the occupied runtime remains.
        await c.sandboxEventProcessor.processSandboxEvent(terminal("quiet-turn", sandboxId, false));
        now += 660_000;
        await c.sandboxEventProcessor.processSandboxEvent({
          type: "heartbeat",
          sandboxId,
          status: "stopping",
          timestamp: now / 1000,
        });
        expect(state.storage.sql.exec("SELECT last_activity FROM sandbox").one()).toEqual({
          last_activity: now,
        });
        await c.lifecycleManager.handleAlarm();
        expect(snapshot).not.toHaveBeenCalled();
        expect(state.storage.sql.exec("SELECT status FROM sandbox").one()).toEqual({
          status: "ready",
        });
      } finally {
        clock.mockRestore();
        snapshot.mockRestore();
      }
    });
  });

  it("contains heartbeat loss independently of the turn deadline without releasing an unconfirmed runtime", async () => {
    const { stub, participantId } = await connectedSession();
    await queueMessage(stub, participantId, "lost-heartbeat");
    await queueMessage(stub, participantId, "after-lost-heartbeat");
    await runInSessionDO(stub, async (instance, state) => {
      const c = componentsOf(instance);
      await c.messageQueue.processMessageQueue();
      const started = Date.now();
      const initialSandboxStatus = state.storage.sql.exec("SELECT status FROM sandbox").one();
      state.storage.sql.exec(
        "UPDATE sandbox SET last_heartbeat = ?, modal_object_id = NULL",
        started - 300_000
      );
      await instance.alarm();
      const stopped = state.storage.sql
        .exec<{
          status: string;
          stop_confirmation_deadline: number;
          cleanup_deadline_ms: number;
        }>(
          "SELECT status, stop_confirmation_deadline, cleanup_deadline_ms FROM messages WHERE id = 'lost-heartbeat'"
        )
        .one();
      expect(stopped.status).toBe("failed");
      expect(stopped.stop_confirmation_deadline).toBeTypeOf("number");
      expect(stopped.cleanup_deadline_ms).toBeGreaterThanOrEqual(started + 900_000);
      expect(stopped.cleanup_deadline_ms).toBeLessThanOrEqual(Date.now() + 900_000);
      // The stop coordinator owns active heartbeat failure. Give the runtime
      // its confirmation window before provider containment, not an idle reap.
      expect(state.storage.sql.exec("SELECT status FROM sandbox").one()).toEqual(
        initialSandboxStatus
      );
      const clock = vi.spyOn(Date, "now").mockReturnValue(stopped.stop_confirmation_deadline + 1);
      try {
        await c.messageQueue.processMessageQueue();
      } finally {
        clock.mockRestore();
      }
      expect(
        state.storage.sql
          .exec("SELECT stop_confirmation_deadline FROM messages WHERE id = 'lost-heartbeat'")
          .one()
      ).toEqual({ stop_confirmation_deadline: expect.any(Number) });
      expect(
        state.storage.sql
          .exec("SELECT status FROM messages WHERE id = 'after-lost-heartbeat'")
          .one()
      ).toEqual({ status: "pending" });
    });
  });
});
