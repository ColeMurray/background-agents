import { describe, expect, it, vi } from "vitest";
import { SessionEventStream, type SessionEventStreamRepository } from "./event-stream";
import type { SandboxEvent } from "../types";
import type { EventRow } from "./types";

type TokenEvent = Extract<SandboxEvent, { type: "token" }>;
type ToolCallEvent = Extract<SandboxEvent, { type: "tool_call" }>;
type ToolResultEvent = Extract<SandboxEvent, { type: "tool_result" }>;

function createStream() {
  const repository = {
    getEventsForReplay: vi.fn(),
    getEventTimelinePage: vi.fn(),
    listEventPage: vi.fn(),
  } as unknown as SessionEventStreamRepository;

  return {
    stream: new SessionEventStream(repository),
    repository,
  };
}

function eventRow(id: string, type: EventRow["type"], data: unknown, createdAt: number): EventRow {
  return {
    id,
    type,
    data: typeof data === "string" ? data : JSON.stringify(data),
    message_id: null,
    created_at: createdAt,
  };
}

function tokenEvent(overrides: Partial<Omit<TokenEvent, "type">> = {}): TokenEvent {
  return {
    type: "token",
    sandboxId: "sandbox-1",
    timestamp: 1,
    messageId: "msg-1",
    content: "hello",
    ...overrides,
  };
}

function toolCallEvent(overrides: Partial<Omit<ToolCallEvent, "type">> = {}): ToolCallEvent {
  return {
    type: "tool_call",
    sandboxId: "sandbox-1",
    timestamp: 1,
    messageId: "msg-1",
    tool: "read_file",
    args: {},
    callId: "call-1",
    ...overrides,
  };
}

function toolResultEvent(overrides: Partial<Omit<ToolResultEvent, "type">> = {}): ToolResultEvent {
  return {
    type: "tool_result",
    sandboxId: "sandbox-1",
    timestamp: 2,
    messageId: "msg-1",
    callId: "call-1",
    result: "ok",
    ...overrides,
  };
}

describe("SessionEventStream", () => {
  describe("getReplay", () => {
    it("loads replay rows with the default replay limit", () => {
      const { stream, repository } = createStream();
      vi.mocked(repository.getEventsForReplay).mockReturnValue([]);

      stream.getReplay();

      expect(repository.getEventsForReplay).toHaveBeenCalledWith(500);
    });

    it("returns parsed replay events and the oldest cursor from the loaded window", () => {
      const { stream, repository } = createStream();
      const toolCall = toolCallEvent({ timestamp: 1 });
      const toolResult = toolResultEvent({ timestamp: 2 });
      vi.mocked(repository.getEventsForReplay).mockReturnValue([
        eventRow("e1", "tool_call", toolCall, 1000),
        eventRow("e2", "tool_result", toolResult, 2000),
      ]);

      const replay = stream.getReplay();

      expect(replay).toEqual({
        events: [toolCall, toolResult],
        hasMore: false,
        cursor: { timestamp: 1000, id: "e1" },
      });
    });

    it("marks replay as having more when the loaded window reaches the limit", () => {
      const { stream, repository } = createStream();
      vi.mocked(repository.getEventsForReplay).mockReturnValue([
        eventRow("e1", "token", tokenEvent({ content: "a", timestamp: 1 }), 1000),
        eventRow("e2", "token", tokenEvent({ content: "b", timestamp: 2 }), 2000),
      ]);

      const replay = stream.getReplay(2);

      expect(replay.hasMore).toBe(true);
    });

    it("skips malformed replay event JSON", () => {
      const { stream, repository } = createStream();
      const toolResult = toolResultEvent({ timestamp: 2 });
      vi.mocked(repository.getEventsForReplay).mockReturnValue([
        eventRow("bad", "tool_call", "{bad", 1000),
        eventRow("good", "tool_result", toolResult, 2000),
      ]);

      const replay = stream.getReplay();

      expect(replay.events).toEqual([toolResult]);
      expect(replay.cursor).toEqual({ timestamp: 1000, id: "bad" });
    });

    it("skips replay events that do not match the sandbox event schema", () => {
      const { stream, repository } = createStream();
      const token = tokenEvent({ timestamp: 2 });
      vi.mocked(repository.getEventsForReplay).mockReturnValue([
        eventRow("bad", "tool_call", { type: "tool_call", tool: "read_file" }, 1000),
        eventRow("good", "token", token, 2000),
      ]);

      const replay = stream.getReplay();

      expect(replay.events).toEqual([token]);
    });
  });

  describe("getHistoryPage", () => {
    it("loads history after a client cursor while excluding heartbeats", () => {
      const { stream, repository } = createStream();
      const toolCall = toolCallEvent({ tool: "write_file", timestamp: 1 });
      vi.mocked(repository.getEventTimelinePage).mockReturnValue({
        events: [eventRow("e1", "tool_call", toolCall, 1000)],
        hasMore: false,
        nextCursor: { kind: "timeline", createdAt: 1000, id: "e1" },
      });

      const page = stream.getHistoryPage({
        cursor: { timestamp: 2000, id: "cursor-id" },
        limit: 100,
      });

      expect(repository.getEventTimelinePage).toHaveBeenCalledWith({
        cursor: { kind: "timeline", createdAt: 2000, id: "cursor-id" },
        excludeTypes: ["heartbeat"],
        limit: 100,
      });
      expect(page).toEqual({
        items: [toolCall],
        hasMore: false,
        cursor: { timestamp: 1000, id: "e1" },
      });
    });

    it("clamps history limits to the supported range", () => {
      const { stream, repository } = createStream();
      vi.mocked(repository.getEventTimelinePage).mockReturnValue({
        events: [],
        hasMore: false,
        nextCursor: null,
      });

      stream.getHistoryPage({ cursor: { timestamp: 2000, id: "cursor-id" }, limit: 999 });
      stream.getHistoryPage({ cursor: { timestamp: 2000, id: "cursor-id" }, limit: 0 });
      stream.getHistoryPage({ cursor: { timestamp: 2000, id: "cursor-id" } });

      expect(repository.getEventTimelinePage).toHaveBeenNthCalledWith(1, {
        cursor: { kind: "timeline", createdAt: 2000, id: "cursor-id" },
        excludeTypes: ["heartbeat"],
        limit: 500,
      });
      expect(repository.getEventTimelinePage).toHaveBeenNthCalledWith(2, {
        cursor: { kind: "timeline", createdAt: 2000, id: "cursor-id" },
        excludeTypes: ["heartbeat"],
        limit: 1,
      });
      expect(repository.getEventTimelinePage).toHaveBeenNthCalledWith(3, {
        cursor: { kind: "timeline", createdAt: 2000, id: "cursor-id" },
        excludeTypes: ["heartbeat"],
        limit: 200,
      });
    });

    it("skips malformed history event JSON", () => {
      const { stream, repository } = createStream();
      const toolResult = toolResultEvent({ timestamp: 2 });
      vi.mocked(repository.getEventTimelinePage).mockReturnValue({
        events: [
          eventRow("bad", "tool_call", "{bad", 1000),
          eventRow("good", "tool_result", toolResult, 2000),
        ],
        hasMore: true,
        nextCursor: { kind: "timeline", createdAt: 1000, id: "bad" },
      });

      const page = stream.getHistoryPage({
        cursor: { timestamp: 3000, id: "cursor-id" },
        limit: 10,
      });

      expect(page).toEqual({
        items: [toolResult],
        hasMore: true,
        cursor: { timestamp: 1000, id: "bad" },
      });
    });
  });

  describe("listEvents", () => {
    it("projects event rows to the shared HTTP response shape", () => {
      const { stream, repository } = createStream();
      vi.mocked(repository.listEventPage).mockReturnValue({
        events: [eventRow("e1", "token", { type: "token", content: "hello" }, 1000)],
        hasMore: true,
        nextCursor: { kind: "timeline", createdAt: 1000, id: "e1" },
      });

      const page = stream.listEvents({
        cursor: null,
        limit: 10,
        type: "token",
        messageId: "m1",
      });

      expect(repository.listEventPage).toHaveBeenCalledWith({
        cursor: null,
        limit: 10,
        type: "token",
        messageId: "m1",
      });
      expect(page).toEqual({
        events: [
          {
            id: "e1",
            type: "token",
            data: { type: "token", content: "hello" },
            messageId: null,
            createdAt: 1000,
          },
        ],
        cursor: "1000:e1",
        hasMore: true,
      });
    });
  });
});
