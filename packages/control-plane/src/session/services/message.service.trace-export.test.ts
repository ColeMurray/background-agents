import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../../node/sqlite-storage";
import { ArtifactRepository } from "../artifact-repository";
import { MAX_INCLUDED_BYTES_PER_SESSION, sessionTraceExportSchema } from "../contracts";
import { EventRepository } from "../event-repository";
import type { SessionMessageQueue } from "../message-queue";
import { MessageRepository } from "../message-repository";
import { initSchema } from "../schema";
import { SessionAttachmentRepository } from "../session-attachment-repository";
import { UsageRepository } from "../usage-repository";
import {
  MAX_INCLUDED_PAGES_PER_SESSION,
  MessageService,
  TRACE_EXPORT_PAGE_SIZE,
} from "./message.service";

const encoder = new TextEncoder();

describe("MessageService.exportTrace", () => {
  let db: DatabaseSync;
  let service: MessageService;
  let repositories: {
    messages: MessageRepository;
    events: EventRepository;
    usage: UsageRepository;
  };
  let transactionDepth: number;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    transactionDepth = 0;
    const transaction = <T>(closure: () => T): T =>
      storage.transactionSync(() => {
        transactionDepth++;
        try {
          return closure();
        } finally {
          transactionDepth--;
        }
      });
    const events = new EventRepository(storage.sql, transaction);
    const usage = new UsageRepository(storage.sql, transaction);
    const messages = new MessageRepository(
      storage.sql,
      transaction,
      new SessionAttachmentRepository(storage.sql),
      events
    );
    repositories = { messages, events, usage };
    service = new MessageService({
      repository: messages,
      eventRepository: events,
      artifactRepository: new ArtifactRepository(storage.sql),
      usageRepository: usage,
      messageQueue: {} as SessionMessageQueue,
      stopExecution: vi.fn(),
      parseArtifactMetadata: vi.fn(),
      transaction,
    });
    db.exec(
      "INSERT INTO session (id, model, harness, created_at, updated_at) VALUES ('s', 'anthropic/claude-sonnet-5', 'opencode', 1, 1)"
    );
    db.exec("INSERT INTO participants (id, user_id, joined_at) VALUES ('p', 'user', 1)");
  });

  afterEach(() => db.close());

  function seedMessage(id: string, createdAt: number, content = "Run the tests"): void {
    db.prepare(
      "INSERT INTO messages (id, author_id, content, source, status, created_at) VALUES (?, 'p', ?, 'web', 'completed', ?)"
    ).run(id, content, createdAt);
  }

  function seedEvent(id: string, createdAt: number, data: Record<string, unknown>): void {
    db.prepare(
      `INSERT INTO events (id, type, data, message_id, created_at, timeline_sequence)
       VALUES (?, ?, ?, 'm1', ?, (SELECT COALESCE(MAX(timeline_sequence), 0) + 1 FROM events))`
    ).run(id, String(data.type), JSON.stringify({ messageId: "m1", ...data }), createdAt);
  }

  function seedStep(stepId: string, createdAt: number): void {
    repositories.usage.recordStepUsage(
      {
        type: "step_finish",
        sandboxId: "sb",
        messageId: "m1",
        stepId,
        timestamp: createdAt,
        tokens: { input: 100, output: 20 },
      },
      "m1",
      createdAt
    );
  }

  it("lists messages newest first, as schema 1 always has, and events and usage in timeline order", () => {
    seedMessage("m1", 1_000);
    seedMessage("m2", 2_000);
    seedEvent("tool_call:call-1", 1_100, {
      type: "tool_call",
      tool: "bash",
      args: { command: "npm test" },
      callId: "call-1",
      status: "completed",
      output: "1 passed",
    });
    seedEvent("token:m1", 1_200, { type: "token", content: "Tests pass." });
    seedEvent("execution_complete:m1", 1_300, { type: "execution_complete", success: true });
    seedStep("step-1", 1_150);
    seedStep("step-2", 1_250);

    const result = service.exportTrace(["messages", "events", "usage"]);

    expect(sessionTraceExportSchema.parse(result)).toEqual(result);
    expect(result).toMatchObject({
      ok: true,
      trace: {
        messages: [
          { id: "m2", content: "Run the tests", createdAt: 2_000 },
          { id: "m1", content: "Run the tests", createdAt: 1_000 },
        ],
        events: [
          {
            id: "tool_call:call-1",
            type: "tool_call",
            data: { output: "1 passed" },
            timelineSequence: 1,
          },
          {
            id: "token:m1",
            type: "token",
            data: { content: "Tests pass." },
            timelineSequence: 2,
          },
          {
            id: "execution_complete:m1",
            type: "execution_complete",
            messageId: "m1",
            timelineSequence: 3,
          },
        ],
        usage: [
          { id: "step-1", messageId: "m1", inputTokens: 100, outputTokens: 20, createdAt: 1_150 },
          { id: "step-2", messageId: "m1", inputTokens: 100, outputTokens: 20, createdAt: 1_250 },
        ],
      },
    });
  });

  it("reads every page of a collection", () => {
    for (let index = 0; index <= TRACE_EXPORT_PAGE_SIZE; index++) {
      seedEvent(`event-${index}`, 1_000 + index, { type: "token", content: `part ${index}` });
    }

    const result = service.exportTrace(["events"]);

    expect(result.ok && result.trace.events?.map((event) => event.id)).toEqual(
      Array.from({ length: TRACE_EXPORT_PAGE_SIZE + 1 }, (_, index) => `event-${index}`)
    );
  });

  it("references the latest repeated output across event pages", () => {
    seedEvent("earlier", 1_000, {
      type: "tool_call",
      tool: "bash",
      args: { command: "run" },
      callId: "earlier",
      output: "same output",
    });
    for (let index = 0; index < TRACE_EXPORT_PAGE_SIZE - 1; index++) {
      seedEvent(`token-${index}`, 1_001 + index, { type: "token", content: "part" });
    }
    seedEvent("latest", 2_000, {
      type: "tool_call",
      tool: "bash",
      args: { command: "run" },
      callId: "latest",
      output: "same output",
    });

    const result = service.exportTrace(["events"], "compact");
    expect(result.ok && result.trace.events?.[0].data).toMatchObject({
      compacted: { output: "ref", ref: "latest" },
    });
    expect(result.ok && result.trace.events?.at(-1)?.data.output).toBe("same output");
  });

  it("orders events that share a timestamp by timeline sequence, across pages", () => {
    for (let index = 0; index <= TRACE_EXPORT_PAGE_SIZE; index++) {
      seedEvent(`event-${index}`, 1_000, { type: "token", content: `part ${index}` });
    }

    const result = service.exportTrace(["events"]);

    expect(
      result.ok && result.trace.events?.map(({ id, timelineSequence }) => [id, timelineSequence])
    ).toEqual(
      Array.from({ length: TRACE_EXPORT_PAGE_SIZE + 1 }, (_, index) => [
        `event-${index}`,
        index + 1,
      ])
    );
  });

  it("includes only the requested collections", () => {
    seedMessage("m1", 1_000);
    seedStep("step-1", 1_150);

    expect(service.exportTrace(["usage"])).toEqual({
      ok: true,
      trace: { usage: [expect.objectContaining({ id: "step-1" })] },
    });
  });

  it("reads every collection inside one storage transaction", () => {
    seedMessage("m1", 1_000);
    seedEvent("token:m1", 1_100, { type: "token", content: "hi" });
    seedStep("step-1", 1_150);
    const readDepths: number[] = [];
    const { messages, events, usage } = repositories;
    const listMessages = messages.listMessages.bind(messages);
    const listEventPage = events.listEventPage.bind(events);
    const listStepUsage = usage.listStepUsage.bind(usage);
    vi.spyOn(messages, "listMessages").mockImplementation((options) => {
      readDepths.push(transactionDepth);
      return listMessages(options);
    });
    vi.spyOn(events, "listEventPage").mockImplementation((options) => {
      readDepths.push(transactionDepth);
      return listEventPage(options);
    });
    vi.spyOn(usage, "listStepUsage").mockImplementation((cursor, limit) => {
      readDepths.push(transactionDepth);
      return listStepUsage(cursor, limit);
    });

    expect(service.exportTrace(["messages", "events", "usage"]).ok).toBe(true);
    expect(readDepths).toEqual([1, 1, 1]);
  });

  it("shares one byte budget across messages and events", () => {
    const overHalfBudget = "x".repeat(MAX_INCLUDED_BYTES_PER_SESSION / 2 + 1);
    seedMessage("m1", 1_000, overHalfBudget);
    seedEvent("token:m1", 1_100, { type: "token", content: overHalfBudget });

    expect(service.exportTrace(["messages"]).ok).toBe(true);
    expect(service.exportTrace(["events"]).ok).toBe(true);
    expect(service.exportTrace(["messages", "events"])).toEqual({
      ok: false,
      reason: "message_budget_exceeded",
    });
  });

  it("charges compacted events instead of raw file reads, without changing full output", () => {
    seedMessage("m1", 1_000);
    const output = "x".repeat(MAX_INCLUDED_BYTES_PER_SESSION / 2 + 1);
    for (let index = 0; index < 3; index++) {
      seedEvent(`read-${index}`, 1_100 + index, {
        type: "tool_call",
        tool: "read",
        args: { filePath: `/workspace/sample-${index}.txt` },
        callId: `read-${index}`,
        status: "completed",
        output,
      });
    }
    seedEvent("edit", 1_200, {
      type: "tool_call",
      tool: "edit",
      args: { oldString: "before", newString: "after" },
      callId: "edit",
      status: "completed",
      output: "done",
    });

    expect(service.exportTrace(["messages", "events"], "full")).toEqual({
      ok: false,
      reason: "message_budget_exceeded",
    });
    const compact = service.exportTrace(["messages", "events"], "compact");
    expect(compact).toMatchObject({
      ok: true,
      trace: {
        messages: [{ content: "Run the tests" }],
        events: [
          {
            data: {
              args: { filePath: "/workspace/sample-0.txt" },
              compacted: { output: "file_read", originalChars: output.length },
            },
          },
          { data: { compacted: { output: "file_read", originalChars: output.length } } },
          { data: { compacted: { output: "file_read", originalChars: output.length } } },
          { data: { args: { oldString: "before", newString: "after" }, output: "done" } },
        ],
      },
    });
    expect(sessionTraceExportSchema.parse(compact)).toEqual(compact);

    db.prepare("DELETE FROM events WHERE id IN ('read-1', 'read-2')").run();
    expect(JSON.stringify(service.exportTrace(["messages", "events"], "full"))).toBe(
      JSON.stringify(service.exportTrace(["messages", "events"]))
    );
  });

  it("charges the response envelope, so an item that alone fills the budget fails", () => {
    seedMessage("m1", 1_000, "");
    const empty = service.exportTrace(["messages"]);
    if (!empty.ok) throw new Error("expected the empty message to export");
    const emptyItemBytes = encoder.encode(JSON.stringify(empty.trace.messages?.[0])).byteLength;
    db.prepare("UPDATE messages SET content = ? WHERE id = 'm1'").run(
      "x".repeat(MAX_INCLUDED_BYTES_PER_SESSION - 1 - emptyItemBytes)
    );

    expect(service.exportTrace(["messages"])).toEqual({
      ok: false,
      reason: "message_budget_exceeded",
    });
  });

  it("shares one page cap across collections", () => {
    const messagePages = MAX_INCLUDED_PAGES_PER_SESSION - 1;
    for (let index = 0; index < messagePages * TRACE_EXPORT_PAGE_SIZE; index++) {
      seedMessage(`m-${index}`, 1_000 + index, "part");
    }
    for (let index = 0; index < TRACE_EXPORT_PAGE_SIZE; index++) {
      seedEvent(`event-${index}`, 1_000 + index, { type: "token", content: "part" });
    }

    expect(service.exportTrace(["messages", "events"]).ok).toBe(true);

    seedEvent("event-last", 5_000, { type: "token", content: "part" });

    expect(service.exportTrace(["messages", "events"])).toEqual({
      ok: false,
      reason: "page_cap_reached",
    });
    expect(service.exportTrace(["events"]).ok).toBe(true);
  });
});
