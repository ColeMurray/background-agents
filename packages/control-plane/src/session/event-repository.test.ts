import { beforeEach, describe, expect, it } from "vitest";
import { EventRepository } from "./event-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const rowsByQuery = new Map<string, unknown[]>();
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      return {
        toArray: () => rowsByQuery.get(query) ?? [],
        one: () => null,
        rowsWritten: 0,
      };
    },
  };
  return {
    sql,
    calls,
    setRows(query: string, rows: unknown[]) {
      rowsByQuery.set(query, rows);
    },
  };
}

describe("EventRepository", () => {
  let mock: ReturnType<typeof createMockSql>;
  let repository: EventRepository;
  let transactionSyncCalls: number;

  beforeEach(() => {
    mock = createMockSql();
    transactionSyncCalls = 0;
    repository = new EventRepository(mock.sql, (closure) => {
      transactionSyncCalls += 1;
      return closure();
    });
  });

  describe("createEvent", () => {
    it("stores event with all fields", () => {
      repository.createEvent({
        id: "evt-1",
        type: "tool_call",
        data: '{"tool":"read"}',
        messageId: "msg-1",
        createdAt: 1000,
      });

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].query).toContain("INSERT INTO events");
      expect(mock.calls[0].params).toEqual([
        "evt-1",
        "tool_call",
        '{"tool":"read"}',
        "msg-1",
        1000,
      ]);
    });
  });

  describe("createContextCompactionEvent", () => {
    it("atomically seals the current token and inserts the compaction marker", () => {
      repository.createContextCompactionEvent({
        id: "compaction-1",
        type: "context_compacted",
        data: '{"type":"context_compacted"}',
        messageId: "msg-1",
        createdAt: 1000,
      });

      expect(transactionSyncCalls).toBe(1);
      expect(mock.calls).toHaveLength(2);
      expect(mock.calls[0].query).toContain("UPDATE events SET id = ? WHERE id = ?");
      expect(mock.calls[0].params).toEqual(["token:msg-1:compaction-1", "token:msg-1"]);
      expect(mock.calls[1].query).toContain("INSERT INTO events");
      expect(mock.calls[1].params).toEqual([
        "compaction-1",
        "context_compacted",
        '{"type":"context_compacted"}',
        "msg-1",
        1000,
      ]);
    });
  });

  describe("upsertTokenEvent", () => {
    it("upserts token events by deterministic message key", () => {
      const event = {
        type: "token" as const,
        content: "partial response",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1,
      };

      repository.upsertTokenEvent("msg-1", event, 1000);

      expect(mock.calls[0].query).toContain("ON CONFLICT(id) DO UPDATE SET");
      expect(mock.calls[0].params).toEqual([
        "token:msg-1",
        "token",
        JSON.stringify(event),
        "msg-1",
        1000,
      ]);
    });

    it("reuses the same deterministic ID across updates", () => {
      const firstEvent = {
        type: "token" as const,
        content: "first",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1,
      };
      const secondEvent = { ...firstEvent, content: "second", timestamp: 2 };

      repository.upsertTokenEvent("msg-1", firstEvent, 1000);
      repository.upsertTokenEvent("msg-1", secondEvent, 2000);

      expect(mock.calls[0].params[0]).toBe("token:msg-1");
      expect(mock.calls[1].params[0]).toBe("token:msg-1");
      expect(mock.calls[1].params[2]).toBe(JSON.stringify(secondEvent));
      expect(mock.calls[1].params[4]).toBe(2000);
    });
  });

  describe("upsertToolCallEvent", () => {
    it("scopes child call IDs and preserves the first event position on updates", () => {
      const event = {
        type: "tool_call" as const,
        tool: "bash",
        args: { command: "npm test" },
        callId: "call-1",
        status: "running",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1,
        isSubtask: true,
        childSessionId: "child-1",
        taskCallId: "task-1",
      };

      repository.upsertToolCallEvent("msg-1", event, 1000);

      expect(mock.calls[0].query).toContain("ON CONFLICT(id) DO UPDATE SET");
      expect(mock.calls[0].query).not.toContain("created_at = excluded.created_at");
      expect(mock.calls[0].params).toEqual([
        'tool_call:["msg-1","child-1","call-1"]',
        "tool_call",
        JSON.stringify(event),
        "msg-1",
        1000,
      ]);
    });

    it("uses a different identity for a parent call with the same call ID", () => {
      const event = {
        type: "tool_call" as const,
        tool: "bash",
        args: {},
        callId: "call-1",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1,
      };

      repository.upsertToolCallEvent("msg-1", event, 1000);
      expect(mock.calls[0].params[0]).toBe('tool_call:["msg-1","parent","call-1"]');
    });
  });

  describe("upsertExecutionCompleteEvent", () => {
    it("upserts completion events by message ID", () => {
      const event = {
        type: "execution_complete" as const,
        messageId: "msg-1",
        sandboxId: "sb-1",
        success: true,
        timestamp: 1,
      };

      repository.upsertExecutionCompleteEvent("msg-1", event, 1000);

      expect(mock.calls[0].params).toEqual([
        "execution_complete:msg-1",
        "execution_complete",
        JSON.stringify(event),
        "msg-1",
        1000,
      ]);
    });
  });

  describe("listEventPage", () => {
    it("returns in deterministic descending order", () => {
      repository.listEventPage({ limit: 50 });
      expect(mock.calls[0].query).toContain("ORDER BY created_at DESC, timeline_sequence DESC");
    });

    it("filters by type", () => {
      repository.listEventPage({ limit: 50, type: "tool_call" });
      expect(mock.calls[0].query).toContain("type = ?");
      expect(mock.calls[0].params).toContain("tool_call");
    });

    it("filters by messageId", () => {
      repository.listEventPage({ limit: 50, messageId: "msg-1" });
      expect(mock.calls[0].query).toContain("message_id = ?");
      expect(mock.calls[0].params).toContain("msg-1");
    });

    it("keeps legacy timestamp cursors for pagination", () => {
      repository.listEventPage({ limit: 50, cursor: { kind: "legacy", createdAt: 5000 } });
      expect(mock.calls[0].query).toContain("created_at < ?");
      expect(mock.calls[0].params).toContain(5000);
    });

    it("uses composite cursors for stable pagination across tied timestamps", () => {
      repository.listEventPage({
        limit: 50,
        cursor: { kind: "timeline", createdAt: 5000, id: "cursor-id" },
      });
      expect(mock.calls[0].query).toContain("((created_at < ?) OR (created_at = ? AND id < ?))");
      expect(mock.calls[0].params).toEqual([5000, 5000, "cursor-id", 51]);
    });

    it("returns hasMore and trims overflow", () => {
      const query = "SELECT * FROM events ORDER BY created_at DESC, timeline_sequence DESC LIMIT ?";
      mock.setRows(query, [
        { id: "e3", created_at: 5000, type: "token", data: "{}" },
        { id: "e2", created_at: 4000, type: "tool_call", data: "{}" },
        { id: "e1", created_at: 3000, type: "token", data: "{}" },
      ]);

      const result = repository.listEventPage({ limit: 2 });

      expect(result.hasMore).toBe(true);
      expect(result.events.map((event) => event.id)).toEqual(["e3", "e2"]);
      expect(result.nextCursor).toEqual({ kind: "timeline", createdAt: 4000, id: "e2" });
    });
  });

  describe("getEventTimelinePage", () => {
    it("queries the first timeline page with deterministic descending storage order", () => {
      repository.getEventTimelinePage({ limit: 50 });

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].query).toBe(
        "SELECT * FROM events ORDER BY created_at DESC, timeline_sequence DESC LIMIT ?"
      );
      expect(mock.calls[0].params).toEqual([51]);
    });

    it("queries timeline pages after a composite cursor", () => {
      repository.getEventTimelinePage({
        limit: 50,
        cursor: { kind: "timeline", createdAt: 5000, id: "cursor-id" },
      });

      expect(mock.calls).toHaveLength(1);
      expect(mock.calls[0].query).toBe(
        "SELECT * FROM events WHERE ((created_at < ?) OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?"
      );
      expect(mock.calls[0].params).toEqual([5000, 5000, "cursor-id", 51]);
    });

    it("queries after a composite cursor and excludes event types", () => {
      repository.getEventTimelinePage({
        limit: 50,
        cursor: { kind: "timeline", createdAt: 5000, id: "cursor-id" },
        excludeTypes: ["heartbeat"],
      });

      expect(mock.calls[0].query).toBe(
        "SELECT * FROM events WHERE type NOT IN (?) AND ((created_at < ?) OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?"
      );
      expect(mock.calls[0].params).toEqual(["heartbeat", 5000, 5000, "cursor-id", 51]);
    });

    it("returns ascending events and preserves the descending page cursor", () => {
      const query = "SELECT * FROM events ORDER BY created_at DESC, timeline_sequence DESC LIMIT ?";
      mock.setRows(query, [
        { id: "e3", created_at: 5000, type: "token", data: "{}" },
        { id: "e2", created_at: 4000, type: "tool_call", data: "{}" },
        { id: "e1", created_at: 3000, type: "token", data: "{}" },
      ]);

      const result = repository.getEventTimelinePage({ limit: 2 });

      expect(result.hasMore).toBe(true);
      expect(result.events.map((event) => event.id)).toEqual(["e2", "e3"]);
      expect(result.nextCursor).toEqual({ kind: "timeline", createdAt: 4000, id: "e2" });
    });

    it("returns hasMore=false when a timeline page fits within the limit", () => {
      const query = "SELECT * FROM events ORDER BY created_at DESC, timeline_sequence DESC LIMIT ?";
      mock.setRows(query, [
        { id: "e2", created_at: 4000, type: "token", data: "{}" },
        { id: "e1", created_at: 3000, type: "tool_call", data: "{}" },
      ]);

      const result = repository.getEventTimelinePage({ limit: 50 });

      expect(result.hasMore).toBe(false);
      expect(result.events.map((event) => event.id)).toEqual(["e1", "e2"]);
      expect(result.nextCursor).toEqual({ kind: "timeline", createdAt: 3000, id: "e1" });
    });
  });
});
