import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  EVENT_CHANGE_JOURNAL_BYTE_LIMIT,
  EVENT_CHANGE_RETENTION_LIMIT,
  EVENT_CHANGE_RETENTION_MS,
  EventRepository,
} from "./event-repository";
import type { SqlResult, SqlStorage } from "./sql-storage";

function createMockSql() {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const rowsByQuery = new Map<string, unknown[]>();
  let currentRevision = 0;
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      calls.push({ query, params });
      const rows = query.includes("RETURNING current_revision")
        ? [{ current_revision: ++currentRevision }]
        : query.includes("AS time_floor")
          ? [{ existing_floor: 0, time_floor: null, count_floor: 0, byte_floor: 0 }]
          : query.includes("AS baseline_bytes")
            ? [{ baseline_bytes: 0, baseline_count: 0, total_bytes: 0, total_count: 0 }]
            : (rowsByQuery.get(query) ?? []);
      return {
        toArray: () => rows,
        one: () => rows[0] ?? null,
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

function eventWrites(calls: Array<{ query: string; params: unknown[] }>) {
  return calls.filter(({ query }) => /(?:INSERT INTO|UPDATE) events/.test(query));
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

      const writes = eventWrites(mock.calls);
      expect(writes).toHaveLength(1);
      expect(writes[0].query).toContain("INSERT INTO events");
      expect(writes[0].params).toEqual(["evt-1", "tool_call", '{"tool":"read"}', "msg-1", 1000, 1]);
      expect(mock.calls.some(({ query }) => query.includes("INSERT INTO event_changes"))).toBe(
        true
      );
      expect(mock.calls.some(({ query }) => query.includes("AS time_floor"))).toBe(false);
    });
  });

  describe("createContextCompactionEvent", () => {
    it("atomically seals the current token and inserts the compaction marker", () => {
      mock.setRows(`UPDATE events SET id = ?, change_revision = ? WHERE id = ? RETURNING id`, [
        { id: "token:msg-1:compaction-1" },
      ]);
      repository.createContextCompactionEvent({
        id: "compaction-1",
        type: "context_compacted",
        data: '{"type":"context_compacted"}',
        messageId: "msg-1",
        createdAt: 1000,
      });

      expect(transactionSyncCalls).toBe(1);
      const writes = eventWrites(mock.calls);
      expect(writes).toHaveLength(2);
      expect(writes[0].query).toContain(
        "UPDATE events SET id = ?, change_revision = ? WHERE id = ?"
      );
      expect(writes[0].params).toEqual(["token:msg-1:compaction-1", 2, "token:msg-1"]);
      expect(writes[1].query).toContain("INSERT INTO events");
      expect(writes[1].params).toEqual([
        "compaction-1",
        "context_compacted",
        '{"type":"context_compacted"}',
        "msg-1",
        1000,
        3,
      ]);
      const journalWrites = mock.calls.filter(({ query }) =>
        query.includes("INSERT INTO event_changes")
      );
      expect(journalWrites).toHaveLength(3);
      expect(journalWrites[0].params.slice(0, 2)).toEqual([1, "token:msg-1"]);
      expect(journalWrites[1].params[2]).toBe("token:msg-1:compaction-1");
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

      const write = eventWrites(mock.calls)[0];
      expect(write.query).toContain("ON CONFLICT(id) DO UPDATE SET");
      expect(write.params).toEqual([
        "token:msg-1",
        "token",
        JSON.stringify(event),
        "msg-1",
        1000,
        1,
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

      const writes = eventWrites(mock.calls);
      expect(writes[0].params[0]).toBe("token:msg-1");
      expect(writes[1].params[0]).toBe("token:msg-1");
      expect(writes[1].params[2]).toBe(JSON.stringify(secondEvent));
      expect(writes[1].params[4]).toBe(2000);
      expect(writes[1].params[5]).toBe(2);
      expect(
        mock.calls.filter(({ query }) => query.includes("INSERT INTO event_changes"))
      ).toHaveLength(2);
      expect(
        mock.calls.filter(({ query }) => query.includes("INSERT INTO event_changes"))[1].query
      ).not.toContain("ON CONFLICT");
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

      const write = eventWrites(mock.calls)[0];
      expect(write.query).toContain("ON CONFLICT(id) DO UPDATE SET");
      expect(write.query).not.toContain("created_at = excluded.created_at");
      expect(write.params).toEqual([
        'tool_call:["msg-1","child-1","call-1"]',
        "tool_call",
        JSON.stringify(event),
        "msg-1",
        1000,
        1,
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
      expect(eventWrites(mock.calls)[0].params[0]).toBe('tool_call:["msg-1","parent","call-1"]');
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

      expect(eventWrites(mock.calls)[0].params).toEqual([
        "execution_complete:msg-1",
        "execution_complete",
        JSON.stringify(event),
        "msg-1",
        1000,
        1,
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

  describe("listEventChanges", () => {
    it("pins the current checkpoint and returns an ascending bounded journal page", () => {
      const stateQuery = `SELECT cursor_scope, current_revision, retention_floor
      FROM event_feed_state WHERE singleton = 1`;
      const pageQuery = `SELECT * FROM event_changes
         WHERE revision > ? AND revision <= ?
         ORDER BY revision ASC LIMIT ?`;
      mock.setRows(stateQuery, [
        { cursor_scope: "a".repeat(32), current_revision: 5, retention_floor: 0 },
      ]);
      mock.setRows(pageQuery, [
        { kind: "upsert", event_id: "e2", revision: 2 },
        { kind: "delete", event_id: "e1", revision: 4 },
        { kind: "upsert", event_id: "e5", revision: 5 },
      ]);

      expect(repository.listEventChanges({ after: 1, limit: 2 })).toMatchObject({
        changes: [{ event_id: "e2" }, { event_id: "e1", kind: "delete" }],
        checkpoint: 5,
        hasMore: true,
        nextCursor: { mode: "changes", checkpoint: 5, revision: 4 },
      });
      expect(mock.calls.find(({ query }) => query === pageQuery)?.params).toEqual([1, 5, 3]);
    });

    it("rejects foreign and future continuation cursors", () => {
      const stateQuery = `SELECT cursor_scope, current_revision, retention_floor
      FROM event_feed_state WHERE singleton = 1`;
      mock.setRows(stateQuery, [
        { cursor_scope: "a".repeat(32), current_revision: 5, retention_floor: 0 },
      ]);
      expect(() =>
        repository.listEventChanges({
          cursor: {
            mode: "changes",
            scope: "b".repeat(32),
            checkpoint: 6,
            revision: 5,
          },
          limit: 50,
        })
      ).toThrow("Invalid event feed cursor");
    });

    it("rejects checkpoints below the monotonic retention floor", () => {
      const stateQuery = `SELECT cursor_scope, current_revision, retention_floor
      FROM event_feed_state WHERE singleton = 1`;
      mock.setRows(stateQuery, [
        { cursor_scope: "a".repeat(32), current_revision: 80_000, retention_floor: 30_000 },
      ]);

      expect(() => repository.listEventChanges({ after: 29_999, limit: 50 })).toThrow(
        "Event feed checkpoint expired"
      );
      expect(() => repository.listEventChanges({ after: 30_000, limit: 50 })).not.toThrow();
      expect(() =>
        repository.listEventChanges({
          cursor: {
            mode: "snapshot",
            scope: "a".repeat(32),
            checkpoint: 29_999,
            createdAt: 1,
            timelineSequence: 1,
          },
          limit: 50,
        })
      ).toThrow("Event feed checkpoint expired");
    });

    it("reads snapshots from canonical events under the captured checkpoint", () => {
      const stateQuery = `SELECT cursor_scope, current_revision, retention_floor
      FROM event_feed_state WHERE singleton = 1`;
      mock.setRows(stateQuery, [
        { cursor_scope: "a".repeat(32), current_revision: 9, retention_floor: 4 },
      ]);

      repository.listEventChanges({ limit: 50 });

      const snapshot = mock.calls.find(({ query }) => query.includes("WITH versions AS"))!;
      expect(snapshot.query).toContain("FROM event_changes WHERE revision <= ?");
      expect(snapshot.query).toContain("FROM events WHERE change_revision <= ?");
      expect(snapshot.params).toEqual([9, 4, 9, 51]);
    });
  });
});

function createRealRepository() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    data TEXT NOT NULL,
    message_id TEXT,
    created_at INTEGER NOT NULL,
    timeline_sequence INTEGER NOT NULL UNIQUE,
    change_revision INTEGER UNIQUE
  );
  CREATE TABLE event_changes (
    revision INTEGER PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('upsert', 'delete')),
    event_id TEXT NOT NULL,
    type TEXT,
    data TEXT,
    message_id TEXT,
    created_at INTEGER,
    timeline_sequence INTEGER,
    changed_at INTEGER NOT NULL,
    journal_bytes INTEGER NOT NULL,
    is_baseline INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE event_feed_state (
    singleton INTEGER PRIMARY KEY,
    cursor_scope TEXT NOT NULL,
    current_revision INTEGER NOT NULL,
    retention_floor INTEGER NOT NULL
  );
  INSERT INTO event_feed_state VALUES (1, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 0, 0);`);
  const sql: SqlStorage = {
    exec(query: string, ...params: unknown[]): SqlResult {
      const values = params as SQLInputValue[];
      if (/^\s*(?:SELECT|PRAGMA|WITH)\b/i.test(query) || /\bRETURNING\b/i.test(query)) {
        const rows = db.prepare(query).all(...values);
        return { toArray: () => rows, one: () => rows[0] ?? null };
      }
      const result = db.prepare(query).run(...values);
      return { toArray: () => [], one: () => null, rowsWritten: Number(result.changes) };
    },
  };
  const transactionSync = <T>(closure: () => T): T => {
    db.exec("BEGIN");
    try {
      const result = closure();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  return { db, repository: new EventRepository(sql, transactionSync) };
}

describe("EventRepository journal retention", () => {
  it("retains immutable versions for one event ID", () => {
    const { db, repository } = createRealRepository();
    try {
      const event = {
        type: "token" as const,
        content: "first",
        messageId: "message-1",
        sandboxId: "sandbox-1",
        timestamp: 1,
      };
      repository.upsertTokenEvent("message-1", event, 1);
      repository.upsertTokenEvent("message-1", { ...event, content: "final" }, 2);

      expect(
        db
          .prepare(`SELECT revision, data FROM event_changes WHERE event_id = ?`)
          .all("token:message-1")
      ).toEqual([
        { revision: 1, data: JSON.stringify(event) },
        { revision: 2, data: JSON.stringify({ ...event, content: "final" }) },
      ]);
    } finally {
      db.close();
    }
  });

  it("continues a pinned snapshot after an unseen event is updated and deleted", () => {
    const { db, repository } = createRealRepository();
    try {
      const token = (messageId: string, content: string, timestamp: number) => ({
        type: "token" as const,
        content,
        messageId,
        sandboxId: "sandbox-1",
        timestamp,
      });
      repository.upsertTokenEvent("m1", token("m1", "one", 1), 1);
      repository.upsertTokenEvent("m2", token("m2", "two", 2), 2);
      repository.upsertTokenEvent("m3", token("m3", "original", 3), 3);

      const first = repository.listEventChanges({ limit: 2 });
      expect(first.changes.map((change) => change.event_id)).toEqual(["token:m1", "token:m2"]);
      expect(first.checkpoint).toBe(3);
      expect(first.nextCursor).not.toBeNull();

      repository.upsertTokenEvent("m3", token("m3", "updated", 4), 4);
      repository.deleteEventWithinTransaction("token:m3");

      const continuation = repository.listEventChanges({ cursor: first.nextCursor!, limit: 2 });
      expect(continuation.changes).toHaveLength(1);
      expect(continuation.changes[0]).toMatchObject({
        revision: 3,
        kind: "upsert",
        event_id: "token:m3",
      });
      expect(JSON.parse(continuation.changes[0].data!)).toMatchObject({ content: "original" });

      const later = repository.listEventChanges({ after: first.checkpoint, limit: 10 });
      expect(later.changes.map(({ revision, kind }) => ({ revision, kind }))).toEqual([
        { revision: 4, kind: "upsert" },
        { revision: 5, kind: "delete" },
      ]);
      expect(db.prepare(`SELECT id FROM events WHERE id = 'token:m3'`).get()).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it("continues an accepted pinned snapshot from a baseline after the floor advances", () => {
    const { db, repository } = createRealRepository();
    try {
      const token = (messageId: string, content: string, timestamp: number) => ({
        type: "token" as const,
        content,
        messageId,
        sandboxId: "sandbox-1",
        timestamp,
      });
      repository.upsertTokenEvent("m1", token("m1", "one", 1), 1);
      repository.upsertTokenEvent("m2", token("m2", "original", 2), 2);
      repository.upsertTokenEvent("m3", token("m3", "three", 3), 3);
      db.prepare(`UPDATE event_changes SET changed_at = ? WHERE revision <= 2`).run(
        Date.now() - EVENT_CHANGE_RETENTION_MS
      );
      expect(() => repository.listEventChanges({ after: 0, limit: 10 })).toThrow(
        "Event feed checkpoint expired"
      );
      repository.upsertTokenEvent("m4", token("m4", "four", 4), 4);

      const first = repository.listEventChanges({ limit: 1 });
      expect(first.checkpoint).toBe(4);
      expect(first.changes[0].event_id).toBe("token:m1");
      repository.upsertTokenEvent("m2", token("m2", "updated", 5), 5);

      const continuation = repository.listEventChanges({ cursor: first.nextCursor!, limit: 1 });
      expect(continuation.changes[0]).toMatchObject({
        revision: 2,
        event_id: "token:m2",
      });
      expect(JSON.parse(continuation.changes[0].data!)).toMatchObject({ content: "original" });
      expect(db.prepare(`SELECT retention_floor FROM event_feed_state`).get()).toEqual({
        retention_floor: 2,
      });
    } finally {
      db.close();
    }
  });

  it("expires old checkpoints after more than 50,000 updates to one event", () => {
    const { db, repository } = createRealRepository();
    try {
      db.exec(`WITH RECURSIVE revisions(value) AS (
        VALUES(1) UNION ALL SELECT value + 1 FROM revisions WHERE value <= ${EVENT_CHANGE_RETENTION_LIMIT}
      )
      INSERT INTO event_changes (revision, kind, event_id, changed_at, journal_bytes)
      SELECT value, 'delete', 'same-event', ${Date.now()}, 64 FROM revisions;
      UPDATE event_feed_state SET current_revision = ${EVENT_CHANGE_RETENTION_LIMIT + 1};`);

      repository.createEvent({
        id: "latest",
        type: "heartbeat",
        data: "{}",
        messageId: null,
        createdAt: 1,
      });

      expect(() => repository.listEventChanges({ after: 1, limit: 10 })).toThrow(
        "Event feed checkpoint expired"
      );
      expect(db.prepare(`SELECT COUNT(*) AS count FROM event_changes`).get()).toEqual({
        count: EVENT_CHANGE_RETENTION_LIMIT,
      });
      expect(db.prepare(`SELECT retention_floor FROM event_feed_state`).get()).toEqual({
        retention_floor: 2,
      });
      expect(() => repository.listEventChanges({ after: 2, limit: 10 })).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("prunes changes once they reach the 24-hour recovery limit", () => {
    const { db, repository } = createRealRepository();
    try {
      db.prepare(
        `INSERT INTO event_changes (revision, kind, event_id, changed_at, journal_bytes)
         VALUES (1, 'delete', 'expired', ?, 64)`
      ).run(Date.now() - EVENT_CHANGE_RETENTION_MS);
      db.exec(`UPDATE event_feed_state SET current_revision = 1`);

      expect(() => repository.listEventChanges({ after: 0, limit: 10 })).toThrow(
        "Event feed checkpoint expired"
      );

      expect(
        db.prepare(`SELECT event_id, is_baseline FROM event_changes ORDER BY revision`).all()
      ).toEqual([]);
      expect(db.prepare(`SELECT retention_floor FROM event_feed_state`).get()).toEqual({
        retention_floor: 1,
      });
    } finally {
      db.close();
    }
  });

  it("advances the floor until retained journal bytes fit the strict cap", () => {
    const { db, repository } = createRealRepository();
    try {
      const content = "x".repeat(9 * 1024 * 1024);
      const event = {
        type: "token" as const,
        content,
        messageId: "large-message",
        sandboxId: "sandbox-1",
        timestamp: 1,
      };
      repository.upsertTokenEvent("large-message", event, 1);
      repository.upsertTokenEvent("large-message", { ...event, timestamp: 2 }, 2);

      expect(() => repository.listEventChanges({ after: 0, limit: 10 })).toThrow(
        "Event feed checkpoint expired"
      );
      expect(db.prepare(`SELECT SUM(journal_bytes) AS bytes FROM event_changes`).get()).toEqual(
        expect.objectContaining({ bytes: expect.any(Number) })
      );
      const retained = db
        .prepare(`SELECT SUM(journal_bytes) AS bytes FROM event_changes`)
        .get() as {
        bytes: number;
      };
      expect(retained.bytes).toBeLessThanOrEqual(EVENT_CHANGE_JOURNAL_BYTE_LIMIT);
      expect(db.prepare(`SELECT retention_floor FROM event_feed_state`).get()).toEqual({
        retention_floor: 2,
      });
    } finally {
      db.close();
    }
  });

  it("rotates cursor scope when required baselines exceed the byte cap", () => {
    const { db, repository } = createRealRepository();
    try {
      const baselineBytes = 9 * 1024 * 1024;
      db.exec(`INSERT INTO event_changes
        (revision, kind, event_id, changed_at, journal_bytes) VALUES
        (1, 'upsert', 'one', 0, ${baselineBytes}),
        (2, 'upsert', 'two', 0, ${baselineBytes});
        UPDATE event_feed_state SET current_revision = 2;`);

      expect(() => repository.listEventChanges({ after: 0, limit: 10 })).toThrow(
        "Event feed checkpoint expired"
      );

      const state = db
        .prepare(`SELECT cursor_scope, retention_floor FROM event_feed_state`)
        .get() as { cursor_scope: string; retention_floor: number };
      expect(state.cursor_scope).not.toBe("a".repeat(32));
      expect(state.retention_floor).toBe(2);
      expect(db.prepare(`SELECT COUNT(*) AS count FROM event_changes`).get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("reports expiry when pruning rotates a previously valid cursor scope", () => {
    const { db, repository } = createRealRepository();
    try {
      const baselineBytes = 9 * 1024 * 1024;
      db.exec(`INSERT INTO event_changes
        (revision, kind, event_id, changed_at, journal_bytes) VALUES
        (1, 'upsert', 'one', 0, ${baselineBytes}),
        (2, 'upsert', 'two', 0, ${baselineBytes});
        UPDATE event_feed_state SET current_revision = 2;`);

      expect(() =>
        repository.listEventChanges({
          cursor: {
            mode: "changes",
            scope: "a".repeat(32),
            checkpoint: 2,
            revision: 0,
          },
          limit: 10,
        })
      ).toThrow("Event feed checkpoint expired");
    } finally {
      db.close();
    }
  });
});
