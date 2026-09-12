import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { createLogger } from "../logger";
import { PersistedAlarmDeadlineStore } from "./alarm/scheduler";
import { EventRepository } from "./event-repository";
import { ExecutionStopCoordinator } from "./execution-stop-coordinator";
import { MessageRepository } from "./message-repository";
import { SessionAttachmentRepository } from "./session-attachment-repository";
import { SCHEMA_SQL } from "./schema";

describe("durable execution containment", () => {
  const databases: DatabaseSync[] = [];
  afterEach(() => {
    vi.restoreAllMocks();
    for (const db of databases.splice(0)) db.close();
  });

  function fixture() {
    const db = new DatabaseSync(":memory:");
    databases.push(db);
    db.exec(SCHEMA_SQL);
    db.exec("INSERT INTO participants (id, user_id, joined_at) VALUES ('author', 'user', 1)");
    const { sql, transactionSync } = createNodeSqlStorage(db);
    const events = new EventRepository(sql, transactionSync);
    const messages = new MessageRepository(
      sql,
      transactionSync,
      new SessionAttachmentRepository(sql),
      events
    );
    const deadlines = new PersistedAlarmDeadlineStore(sql);
    const terminate = vi.fn(async (_reason: string, _deadline?: number) => false);
    const schedule = vi.fn(async (_at: number) => {});
    const broadcast = vi.fn();
    const processQueue = vi.fn(async () => {});
    function coordinator() {
      return new ExecutionStopCoordinator(
        createLogger("test"),
        { transaction: transactionSync } as never,
        messages,
        {} as never,
        { broadcast } as never,
        {} as never,
        {} as never,
        { terminateUnresponsiveSandbox: terminate } as never,
        { schedule } as never,
        new PersistedAlarmDeadlineStore(sql),
        vi.fn(),
        processQueue
      );
    }
    messages.createMessage({
      id: "turn",
      authorId: "author",
      content: "work",
      source: "web",
      status: "processing",
      createdAt: 1,
    });
    sql.exec(
      "UPDATE messages SET started_at = 10, execution_deadline_ms = 9000, cleanup_deadline_ms = 10000, execution_sandbox_id = 'sandbox-A', requires_stop_evidence = 1 WHERE id = 'turn'"
    );
    events.createEvent({
      id: "user_message:turn",
      type: "user_message",
      data: "{}",
      messageId: "turn",
      createdAt: 10,
    });
    return {
      db,
      sql,
      messages,
      events,
      deadlines,
      terminate,
      schedule,
      broadcast,
      processQueue,
      coordinator,
    };
  }

  it("rolls back the pending state, speculative event deletion, stop fence and alarm intent together", () => {
    const h = fixture();
    expect(() =>
      h.messages.prepareDispatchRecovery("turn", 1000, () => {
        h.deadlines.setPendingEarliest(1000);
        throw new Error("crash before commit");
      })
    ).toThrow("crash before commit");
    expect(h.messages.getMessageStatus("turn")).toBe("processing");
    expect(h.messages.getMessageAwaitingStopConfirmation()).toBeNull();
    expect(h.sql.exec("SELECT id FROM events").toArray()).toEqual([{ id: "user_message:turn" }]);
    expect(h.deadlines.earliest()).toBeNull();

    expect(h.coordinator().prepareDispatchRecovery("turn", 100)).toEqual({
      messageId: "turn",
      sandboxId: "sandbox-A",
    });
    expect(h.messages.getMessageStatus("turn")).toBe("pending");
    expect(h.messages.getMessageAwaitingStopConfirmation()).toEqual({
      id: "turn",
      deadline: 10000,
    });
    expect(h.sql.exec("SELECT id FROM events").toArray()).toEqual([]);
    expect(new PersistedAlarmDeadlineStore(h.sql).earliest()).toBe(10000);
    expect(h.sql.exec("SELECT started_at, execution_deadline_ms FROM messages").one()).toEqual({
      started_at: 10,
      execution_deadline_ms: 9000,
    });
    expect(
      h.messages.startMessageProcessing("turn", 100, {
        type: "user_message",
        messageId: "turn",
        content: "work",
        timestamp: 0.1,
      })
    ).toBe(false);
  });

  it("persists capped backoff across reconstruction and escalates once after five failed attempts", async () => {
    const h = fixture();
    h.messages.prepareDispatchRecovery("turn", 1000, () => h.deadlines.setPendingEarliest(1000));
    const clock = vi.spyOn(Date, "now");
    for (const [index, delay] of [15_000, 30_000, 60_000, 60_000, 60_000].entries()) {
      const now = h.messages.getMessageAwaitingStopConfirmation()!.deadline;
      clock.mockReturnValue(now);
      h.deadlines.beginDelivery();
      await h.coordinator().recoverStopConfirmationTimeout();
      h.deadlines.completeDelivery();
      expect(h.messages.getMessageExecutionMetadata("turn")?.stop_containment_attempts).toBe(
        index + 1
      );
      expect(h.messages.getMessageAwaitingStopConfirmation()!.deadline).toBe(now + delay);
      expect(h.deadlines.earliest()).toBe(now + delay);
      expect(h.terminate).toHaveBeenLastCalledWith("stop_confirmation_timeout", 10000);
    }
    const escalated = h.messages.getMessageExecutionMetadata("turn")!.stop_escalated_at;
    expect(escalated).toBeTypeOf("number");
    clock.mockReturnValue(1_000_000);
    await h.coordinator().recoverStopConfirmationTimeout();
    await h.coordinator().recoverStopConfirmationTimeout();
    expect(h.terminate).toHaveBeenCalledTimes(5);
    expect(h.messages.getMessageAwaitingStopConfirmation()).not.toBeNull();
    expect(h.sql.exec("SELECT type, message_id FROM events").toArray()).toEqual([
      { type: "warning", message_id: "turn" },
    ]);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.processQueue).not.toHaveBeenCalled();
    await h.coordinator().resumeAfterSandboxTermination("turn", "sandbox-B");
    expect(h.messages.getMessageAwaitingStopConfirmation()).not.toBeNull();
    await h.coordinator().resumeAfterSandboxTermination("turn", "sandbox-A");
    expect(h.messages.getMessageAwaitingStopConfirmation()).toBeNull();
    expect(h.processQueue).toHaveBeenCalledOnce();
  });

  it("counts a pre-crash last attempt and escalates on recovery without another provider call", async () => {
    const h = fixture();
    h.messages.prepareDispatchRecovery("turn", 1000, () => {});
    h.sql.exec("UPDATE messages SET stop_containment_attempts = 4");
    expect(
      h.messages.claimStopContainmentAttempt("turn", 2000, 5, () =>
        h.deadlines.setPendingEarliest(2000)
      )
    ).toBe(5);
    vi.spyOn(Date, "now").mockReturnValue(2000);
    await h.coordinator().recoverStopConfirmationTimeout();
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.messages.getMessageExecutionMetadata("turn")?.stop_escalated_at).toBe(2000);
    expect(h.messages.getMessageAwaitingStopConfirmation()).not.toBeNull();
  });

  it("does not terminate a replacement after awaiting the runtime alarm write", async () => {
    const h = fixture();
    h.messages.prepareDispatchRecovery("turn", 1000, () => {});
    vi.spyOn(Date, "now").mockReturnValue(1000);
    let release!: () => void;
    h.schedule.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      })
    );
    const recovery = h.coordinator().recoverStopConfirmationTimeout();
    h.sql.exec("UPDATE messages SET execution_sandbox_id = 'sandbox-B'");
    release();
    await recovery;
    expect(h.terminate).not.toHaveBeenCalled();
    expect(h.messages.getMessageAwaitingStopConfirmation()).not.toBeNull();
  });

  it("observes only a launch scoped to its automation run and expires only never-dispatched admission", () => {
    const h = fixture();
    const context = {
      source: "slack",
      runId: "run",
      executionLaunchId: "launch",
      admissionDeadlineMs: 1000,
    };
    h.messages.createMessage({
      id: "pending",
      authorId: "author",
      content: "steer",
      source: "slack",
      status: "pending",
      callbackContext: JSON.stringify(context),
      createdAt: 1,
    });
    expect(h.messages.getExecutionLaunch("other-run", "launch")).toBeNull();
    expect(h.messages.getExecutionLaunch("run", "launch")).toEqual({
      messageId: "pending",
      status: "pending",
      error: null,
    });
    expect(h.messages.listPendingAdmissionDeadlines()).toEqual([{ id: "pending", deadline: 1000 }]);
    h.sql.exec("UPDATE messages SET execution_deadline_ms = 9000 WHERE id = 'pending'");
    expect(h.messages.listPendingAdmissionDeadlines()).toEqual([]);
    h.sql.exec(
      "UPDATE messages SET execution_deadline_ms = NULL, stop_confirmation_deadline = 9000 WHERE id = 'pending'"
    );
    expect(h.messages.listPendingAdmissionDeadlines()).toEqual([]);
  });

  it("returns the persisted smaller cleanup bound on a legacy row without a reserve", () => {
    const h = fixture();
    expect(h.messages.beginMessageCleanup("turn", 100, 12000)).toBe(10000);
    expect(h.messages.beginMessageCleanup("turn", 100, 5000)).toBe(5000);
    expect(h.messages.beginMessageCleanup("turn", 200)).toBeNull();
    expect(h.messages.getMessageExecutionMetadata("turn")?.cleanup_deadline_ms).toBe(5000);
  });
});
