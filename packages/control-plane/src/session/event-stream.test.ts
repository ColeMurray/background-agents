import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REPLAY_LIMIT,
  SessionEventStream,
  type SessionEventStreamRepository,
} from "./event-stream";
import type { EventRow } from "./types";

function createStream() {
  const repository = {
    getEventTimelinePage: vi.fn(),
    listEventPage: vi.fn(),
  } as unknown as SessionEventStreamRepository;

  return {
    stream: new SessionEventStream(repository),
    repository,
  };
}

function eventRow(
  id: string,
  type: EventRow["type"],
  data: Record<string, unknown> | string,
  createdAt: number,
  timelineSequence?: number
): EventRow {
  return {
    id,
    type,
    data: typeof data === "string" ? data : JSON.stringify(data),
    message_id: null,
    created_at: createdAt,
    timeline_sequence: timelineSequence,
  };
}

function gitSyncEvent(status: "in_progress" | "completed", timestamp: number) {
  return { type: "git_sync", status, sandboxId: "sandbox-1", timestamp } as const;
}

describe("SessionEventStream", () => {
  describe("getReplay", () => {
    it("loads replay through the canonical timeline pager", () => {
      const { stream, repository } = createStream();
      vi.mocked(repository.getEventTimelinePage).mockReturnValue({
        events: [],
        hasMore: false,
        nextCursor: null,
      });

      stream.getReplay();

      expect(repository.getEventTimelinePage).toHaveBeenCalledWith({
        excludeTypes: ["heartbeat"],
        limit: DEFAULT_REPLAY_LIMIT,
      });
    });

    it("returns parsed replay events and the oldest cursor from the loaded window", () => {
      const { stream, repository } = createStream();
      vi.mocked(repository.getEventTimelinePage).mockReturnValue({
        events: [
          eventRow("e1", "git_sync", gitSyncEvent("in_progress", 1), 1000, 41),
          eventRow("e2", "git_sync", gitSyncEvent("completed", 2), 2000, 42),
        ],
        hasMore: false,
        nextCursor: { kind: "timeline", createdAt: 1000, id: "e1", sequence: 41 },
      });

      const replay = stream.getReplay();

      expect(replay).toEqual({
        events: [
          expect.objectContaining({ eventId: "e1", timelineSequence: 41 }),
          expect.objectContaining({ eventId: "e2", timelineSequence: 42 }),
        ],
        hasMore: false,
        cursor: { timestamp: 1000, id: "e1", sequence: 41 },
      });
    });

    it("returns the canonical page's pagination state", () => {
      const { stream, repository } = createStream();
      vi.mocked(repository.getEventTimelinePage).mockReturnValue({
        events: [
          eventRow("e1", "git_sync", gitSyncEvent("in_progress", 1), 1000, 1),
          eventRow("e2", "git_sync", gitSyncEvent("completed", 2), 2000, 2),
        ],
        hasMore: true,
        nextCursor: { kind: "timeline", createdAt: 1000, id: "e1", sequence: 1 },
      });

      const replay = stream.getReplay(2);

      expect(replay.hasMore).toBe(true);
      expect(replay.events.map((event) => event.eventId)).toEqual(["e1", "e2"]);
      expect(replay.cursor).toEqual({ timestamp: 1000, id: "e1", sequence: 1 });
    });

    it("skips malformed replay event JSON", () => {
      const { stream, repository } = createStream();
      vi.mocked(repository.getEventTimelinePage).mockReturnValue({
        events: [
          eventRow("bad", "tool_call", "{bad", 1000),
          eventRow("good", "git_sync", gitSyncEvent("completed", 2), 2000, 42),
        ],
        hasMore: false,
        nextCursor: { kind: "timeline", createdAt: 1000, id: "bad" },
      });

      const replay = stream.getReplay();

      expect(replay.events).toEqual([
        expect.objectContaining({
          eventId: "good",
          event: expect.objectContaining({ status: "completed" }),
        }),
      ]);
      expect(replay.cursor).toEqual({ timestamp: 1000, id: "bad" });
    });
  });

  describe("getHistoryPage", () => {
    it("loads history after a client cursor while excluding heartbeats", () => {
      const { stream, repository } = createStream();
      vi.mocked(repository.getEventTimelinePage).mockReturnValue({
        events: [eventRow("e1", "git_sync", gitSyncEvent("completed", 1), 1000, 41)],
        hasMore: false,
        nextCursor: { kind: "timeline", createdAt: 1000, id: "e1", sequence: 41 },
      });

      const page = stream.getHistoryPage({
        cursor: { timestamp: 2000, id: "cursor-id", sequence: 42 },
        limit: 100,
      });

      expect(repository.getEventTimelinePage).toHaveBeenCalledWith({
        cursor: { kind: "timeline", createdAt: 2000, id: "cursor-id", sequence: 42 },
        excludeTypes: ["heartbeat"],
        limit: 100,
      });
      expect(page).toEqual({
        items: [expect.objectContaining({ eventId: "e1", timelineSequence: 41 })],
        hasMore: false,
        cursor: { timestamp: 1000, id: "e1", sequence: 41 },
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
      vi.mocked(repository.getEventTimelinePage).mockReturnValue({
        events: [
          eventRow("bad", "tool_call", "{bad", 1000),
          eventRow("good", "git_sync", gitSyncEvent("completed", 2), 2000, 42),
        ],
        hasMore: true,
        nextCursor: { kind: "timeline", createdAt: 1000, id: "bad" },
      });

      const page = stream.getHistoryPage({
        cursor: { timestamp: 3000, id: "cursor-id" },
        limit: 10,
      });

      expect(page).toEqual({
        items: [expect.objectContaining({ eventId: "good", timelineSequence: 42 })],
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
