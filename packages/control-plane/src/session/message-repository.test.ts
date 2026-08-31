import { beforeEach, describe, expect, it, vi } from "vitest";
import { EventRepository } from "./event-repository";
import { MessageRepository } from "./message-repository";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";
import {
  AttachmentClaimConflictError,
  SessionAttachmentRepository,
} from "./session-attachment-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const data = new Map<string, unknown[]>();
  const matchingData: Array<{ pattern: RegExp; rows: unknown[] }> = [];
  let oneValue: unknown = null;
  let rowsWritten = 0;
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      let consumed = false;
      return {
        toArray: () => {
          consumed = true;
          return (
            data.get(query) ?? matchingData.find(({ pattern }) => pattern.test(query))?.rows ?? []
          );
        },
        one: () => oneValue,
        get rowsWritten() {
          return consumed ? rowsWritten : 0;
        },
      };
    },
  };
  return {
    sql,
    calls,
    setData: (query: string, rows: unknown[]) => data.set(query, rows),
    setMatchingData: (pattern: RegExp, rows: unknown[]) => matchingData.push({ pattern, rows }),
    setOne: (value: unknown) => (oneValue = value),
    setRowsWritten: (value: number) => (rowsWritten = value),
  };
}

describe("MessageRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repository: MessageRepository;
  let transactionSyncCalls: number;

  beforeEach(() => {
    mock = createMockSql();
    transactionSyncCalls = 0;
    repository = new MessageRepository(
      mock.sql,
      (closure) => {
        transactionSyncCalls += 1;
        return closure();
      },
      new SessionAttachmentRepository(mock.sql),
      new EventRepository(mock.sql, (closure) => closure())
    );
  });

  it("counts all and unfinished messages", () => {
    mock.setOne({ count: 5 });
    expect(repository.getMessageCount()).toBe(5);
    expect(repository.getPendingOrProcessingCount()).toBe(5);
    expect(mock.calls[1].query).toContain("'pending', 'processing'");
  });

  it("calculates active duration", () => {
    mock.setOne({ duration_ms: 4500 });
    expect(repository.getActiveDurationMs()).toBe(4500);
  });

  it("reads processing and pending messages", () => {
    const processingQuery = `SELECT id FROM messages WHERE status = 'processing' LIMIT 1`;
    const pendingQuery = `SELECT * FROM messages WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC LIMIT 1`;
    mock.setData(processingQuery, [{ id: "msg-processing" }]);
    mock.setData(pendingQuery, [{ id: "msg-pending", created_at: 1 }]);
    expect(repository.getProcessingMessage()).toEqual({ id: "msg-processing" });
    expect(repository.getNextPendingMessage()).toEqual({ id: "msg-pending", created_at: 1 });
  });

  it("reads processing message timestamps", () => {
    mock.setData(`SELECT id, created_at FROM messages WHERE status = 'processing' LIMIT 1`, [
      { id: "msg-1", created_at: 1000 },
    ]);
    mock.setData(`SELECT id, started_at FROM messages WHERE status = 'processing' LIMIT 1`, [
      { id: "msg-1", started_at: 1200 },
    ]);
    expect(repository.getProcessingMessageWithCreatedAt()).toEqual({
      id: "msg-1",
      created_at: 1000,
    });
    expect(repository.getProcessingMessageWithStartedAt()).toEqual({
      id: "msg-1",
      started_at: 1200,
    });
  });

  it("tracks stop confirmation deadlines", () => {
    const query = `SELECT id, stop_confirmation_deadline FROM messages
       WHERE stop_confirmation_deadline IS NOT NULL LIMIT 1`;
    mock.setData(query, [{ id: "msg-1", stop_confirmation_deadline: 5000 }]);
    repository.markMessageAwaitingStopConfirmation("msg-1", 5000);
    expect(repository.getMessageAwaitingStopConfirmation()).toEqual({
      id: "msg-1",
      deadline: 5000,
    });
    repository.clearMessageAwaitingStopConfirmation("msg-1");
    expect(mock.calls[2].query).toContain("stop_confirmation_deadline = NULL");
  });

  it("looks up idempotent requests and unfinished positions", () => {
    const lookup = `SELECT * FROM messages WHERE client_request_id = ? LIMIT 1`;
    const positions = `SELECT id FROM messages WHERE status IN ('pending', 'processing')
       ORDER BY CASE status WHEN 'processing' THEN 0 ELSE 1 END, created_at ASC, rowid ASC`;
    mock.setData(lookup, [{ id: "msg-2" }]);
    mock.setData(positions, [{ id: "msg-1" }, { id: "msg-2" }]);
    expect(repository.getMessageByClientRequestId("request-1")).toEqual({ id: "msg-2" });
    expect(repository.getUnfinishedMessagePosition("msg-2")).toBe(2);
    expect(repository.getUnfinishedMessagePosition("finished")).toBeNull();
  });

  it("projects unfinished messages into the prompt queue", () => {
    vi.spyOn(repository, "listUnfinishedMessages").mockReturnValue([
      { id: "msg-1", content: "Continue", status: "pending" } as never,
    ]);
    expect(repository.listPromptQueue()).toEqual([
      { messageId: "msg-1", content: "Continue", status: "pending" },
    ]);
  });

  it("creates a message with all fields", () => {
    repository.createMessage({
      id: "msg-1",
      authorId: "p-1",
      content: "Hello",
      source: "web",
      model: "claude-sonnet-4",
      attachments: "[]",
      callbackContext: '{"channel":"C123"}',
      status: "pending",
      createdAt: 1000,
    });
    expect(mock.calls[0].query).toContain("INSERT INTO messages");
    expect(mock.calls[0].params).toEqual([
      "msg-1",
      "p-1",
      "Hello",
      "web",
      "claude-sonnet-4",
      null,
      "[]",
      '{"channel":"C123"}',
      null,
      null,
      null,
      null,
      null,
      "pending",
      1000,
    ]);
  });

  it("atomically deduplicates Autofix feedback before other admission checks", () => {
    mock.setData(`SELECT id FROM messages WHERE autofix_feedback_key = ? LIMIT 1`, [
      { id: "msg-existing" },
    ]);

    expect(
      repository.admitAutofixMessage({
        message: {
          id: "msg-new",
          authorId: "p-1",
          content: "Fix feedback",
          source: "github",
          status: "pending",
          createdAt: 2000,
        },
        feedbackKey: "github:review:1",
        pullRequestKey: "github:99:42",
        originContext: "{}",
        attemptLimit: 3,
        windowStart: 1000,
        sessionClosed: true,
      })
    ).toEqual({ kind: "duplicate", messageId: "msg-existing" });
    expect(transactionSyncCalls).toBe(1);
    expect(mock.calls).toHaveLength(1);
  });

  it("rejects new Autofix feedback for a closed session", () => {
    expect(
      repository.admitAutofixMessage({
        message: {
          id: "msg-new",
          authorId: "p-1",
          content: "Fix feedback",
          source: "github",
          status: "pending",
          createdAt: 2000,
        },
        feedbackKey: "github:review:1",
        pullRequestKey: "github:99:42",
        originContext: "{}",
        attemptLimit: 3,
        windowStart: 1000,
        sessionClosed: true,
      })
    ).toEqual({ kind: "rejected", reason: "session_closed" });
    expect(mock.calls).toHaveLength(1);
  });

  it("rejects Autofix admission when the rolling PR cap is reached", () => {
    mock.setOne({ count: 3 });

    expect(
      repository.admitAutofixMessage({
        message: {
          id: "msg-new",
          authorId: "p-1",
          content: "Fix feedback",
          source: "github",
          status: "pending",
          createdAt: 2000,
        },
        feedbackKey: "github:review:1",
        pullRequestKey: "github:99:42",
        originContext: "{}",
        attemptLimit: 3,
        windowStart: 1000,
        sessionClosed: false,
      })
    ).toEqual({ kind: "rejected", reason: "attempt_limit" });
    expect(mock.calls).toHaveLength(3);
  });

  it("admits Autofix feedback without checking the rolling count when there is no limit", () => {
    mock.setOne({ count: 0 });

    expect(
      repository.admitAutofixMessage({
        message: {
          id: "msg-new",
          authorId: "p-1",
          content: "Fix feedback",
          source: "github",
          status: "pending",
          createdAt: 2000,
        },
        feedbackKey: "github:review:1",
        pullRequestKey: "github:99:42",
        originContext: "{}",
        attemptLimit: null,
        windowStart: 1000,
        sessionClosed: false,
      })
    ).toEqual({ kind: "enqueued", messageId: "msg-new" });
    expect(mock.calls.some(({ query }) => query.includes("autofix_pr_key = ?"))).toBe(false);
  });

  it("rejects Autofix admission when the session queue is full", () => {
    mock.setOne({ count: MAX_UNFINISHED_PROMPTS });

    expect(
      repository.admitAutofixMessage({
        message: {
          id: "msg-new",
          authorId: "p-1",
          content: "Fix feedback",
          source: "github",
          status: "pending",
          createdAt: 2000,
        },
        feedbackKey: "github:review:1",
        pullRequestKey: "github:99:42",
        originContext: "{}",
        attemptLimit: 50,
        windowStart: 1000,
        sessionClosed: false,
      })
    ).toEqual({ kind: "rejected", reason: "queue_full" });
    expect(mock.calls).toHaveLength(2);
  });

  it("admits Autofix metadata without creating an admission-time event", () => {
    mock.setOne({ count: 2 });
    const originContext = JSON.stringify({
      kind: "review",
      authorType: "human",
      feedbackUrl: "https://github.com/acme/repo/pull/42#pullrequestreview-1",
    });

    expect(
      repository.admitAutofixMessage({
        message: {
          id: "msg-new",
          authorId: "p-1",
          content: "Fix feedback",
          source: "github",
          status: "pending",
          createdAt: 2000,
        },
        feedbackKey: "github:review:1",
        pullRequestKey: "github:99:42",
        originContext,
        attemptLimit: 3,
        windowStart: 1000,
        sessionClosed: false,
      })
    ).toEqual({ kind: "enqueued", messageId: "msg-new" });
    const insert = mock.calls.find(({ query }) => query.includes("INSERT INTO messages"));
    expect(insert?.params).toEqual(
      expect.arrayContaining(["github:review:1", "github:99:42", originContext])
    );
    expect(mock.calls.some(({ query }) => query.includes("INSERT INTO events"))).toBe(false);
  });

  it("atomically claims attachments and creates a message", () => {
    mock.setRowsWritten(2);
    repository.createMessageWithAttachments(
      {
        id: "msg-1",
        authorId: "p-1",
        content: "Look",
        source: "web",
        status: "pending",
        createdAt: 1,
      },
      ["up-1", "up-2"]
    );
    expect(transactionSyncCalls).toBe(1);
    expect(mock.calls[0].query).toContain("UPDATE attachments SET message_id");
    expect(mock.calls[1].query).toContain("INSERT INTO messages");
  });

  it("does not create a message when attachments cannot all be claimed", () => {
    mock.setRowsWritten(1);
    expect(() =>
      repository.createMessageWithAttachments(
        {
          id: "msg-1",
          authorId: "p-1",
          content: "Look",
          source: "web",
          status: "pending",
          createdAt: 1,
        },
        ["up-1", "up-2"]
      )
    ).toThrow(AttachmentClaimConflictError);
    expect(mock.calls).toHaveLength(1);
  });

  it("atomically releases attachments and cancels a pending web message", () => {
    mock.setData(`SELECT status, source, callback_context FROM messages WHERE id = ?`, [
      { status: "pending", source: "web", callback_context: null },
    ]);
    mock.setRowsWritten(1);
    expect(repository.cancelPendingMessage("msg-1")).toBe(true);
    expect(transactionSyncCalls).toBe(1);
    expect(mock.calls[1].query).toContain("UPDATE attachments SET message_id = NULL");
    expect(mock.calls[2].query).toContain("DELETE FROM messages");
  });

  it("rejects cancellation for messages that may need callbacks", () => {
    mock.setData(`SELECT status, source, callback_context FROM messages WHERE id = ?`, [
      { status: "pending", source: "linear", callback_context: null },
    ]);
    expect(repository.cancelPendingMessage("msg-1")).toBe(false);
    expect(mock.calls).toHaveLength(1);
  });

  it("atomically starts processing and creates the canonical user event", () => {
    mock.setMatchingData(/UPDATE messages SET status = 'processing'[\s\S]*RETURNING id/, [
      { id: "msg-1" },
    ]);
    expect(
      repository.startMessageProcessing("msg-1", 2000, {
        type: "user_message",
        content: "Hello",
        messageId: "msg-1",
        timestamp: 2,
        author: { participantId: "p-1", userId: "u-1", name: "User" },
      })
    ).toBe(true);
    expect(transactionSyncCalls).toBe(1);
    expect(mock.calls[0].query).toContain("status = 'processing'");
    expect(mock.calls[0].query).toContain("status = 'pending'");
    expect(mock.calls[0].query).toContain("NOT EXISTS");
    expect(mock.calls[1].params[0]).toBe("user_message:msg-1");
  });

  it("does not create a user event when the processing claim is lost", () => {
    expect(
      repository.startMessageProcessing("msg-1", 2000, {
        type: "user_message",
        content: "Hello",
        messageId: "msg-1",
        timestamp: 2,
        author: { participantId: "p-1", userId: "u-1", name: "User" },
      })
    ).toBe(false);
    expect(mock.calls).toHaveLength(1);
  });

  it("returns an undispatched processing message to pending and removes its user event", () => {
    mock.setMatchingData(/UPDATE messages SET status = 'pending'[\s\S]*RETURNING id/, [
      { id: "msg-1" },
    ]);
    repository.updateMessageToPending("msg-1");
    expect(mock.calls[0].query).toContain("status = 'pending'");
    expect(mock.calls[0].params).toEqual(["msg-1"]);
    expect(mock.calls[1].params).toEqual(["user_message:msg-1"]);
  });

  it("atomically records message completion and its canonical event", () => {
    mock.setData(`SELECT status, created_at, started_at FROM messages WHERE id = ?`, [
      { status: "processing", created_at: 1000, started_at: 1200 },
    ]);
    const event = {
      type: "execution_complete" as const,
      messageId: "msg-1",
      success: true,
      sandboxId: "sb-1",
      timestamp: 3,
    };
    expect(repository.recordMessageCompletion(event, 3000, "processing")).toEqual({
      messageId: "msg-1",
      messageCreatedAt: 1000,
      messageStartedAt: 1200,
      completedAt: 3000,
      status: "completed",
    });
    expect(transactionSyncCalls).toBe(1);
    expect(mock.calls[2].params[0]).toBe("execution_complete:msg-1");
  });

  it("does not complete a message in another state", () => {
    mock.setData(`SELECT status, created_at, started_at FROM messages WHERE id = ?`, [
      { status: "completed", created_at: 1000, started_at: 1200 },
    ]);
    expect(
      repository.recordMessageCompletion(
        {
          type: "execution_complete",
          messageId: "msg-1",
          success: true,
          sandboxId: "sb-1",
          timestamp: 3,
        },
        3000,
        "processing"
      )
    ).toBeNull();
    expect(mock.calls).toHaveLength(1);
  });

  it("lists pending messages in deterministic order", () => {
    const query = `SELECT id, created_at FROM messages WHERE status = 'pending' ORDER BY created_at ASC, rowid ASC`;
    mock.setData(query, [{ id: "msg-1", created_at: 1000 }]);
    expect(repository.listPendingMessagesWithCreatedAt()).toEqual([
      { id: "msg-1", created_at: 1000 },
    ]);
  });

  it("builds message list pagination filters", () => {
    repository.listMessages({ limit: 10, status: "pending", cursor: "5000" });
    expect(mock.calls[0].query).toContain("status = ?");
    expect(mock.calls[0].query).toContain("created_at < ?");
    expect(mock.calls[0].params).toEqual(["pending", 5000, 11]);
  });

  it("selects the latest terminal message", () => {
    repository.getLatestTerminalMessage();
    expect(mock.calls[0].query).toContain("status IN ('completed', 'failed')");
    expect(mock.calls[0].query).toContain("COALESCE(completed_at, started_at, created_at) DESC");
  });

  it("reads callback context and processing author", () => {
    mock.setData(`SELECT callback_context, source FROM messages WHERE id = ?`, [
      { callback_context: '{"channel":"C123"}', source: "slack" },
    ]);
    mock.setData(`SELECT author_id FROM messages WHERE status = 'processing' LIMIT 1`, [
      { author_id: "p-1" },
    ]);
    expect(repository.getMessageCallbackContext("msg-1")).toEqual({
      callback_context: '{"channel":"C123"}',
      source: "slack",
    });
    expect(repository.getProcessingMessageAuthor()).toEqual({ author_id: "p-1" });
  });
});
