import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { EventRepository } from "./event-repository";
import { SessionEventStream, type EventStreamCursor } from "./event-stream";
import { initSchema } from "./schema";
import { parseEventListCursor } from "./event-cursor";

describe("bounded timeline replay over SQLite", () => {
  let db: DatabaseSync;
  let repository: EventRepository;
  let stream: SessionEventStream;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    repository = new EventRepository(storage.sql, storage.transactionSync);
    stream = new SessionEventStream(repository);
  });
  afterEach(() => db.close());

  function seed(count: number, content: string) {
    for (let i = 0; i < count; i++)
      repository.createEvent({
        id: `event-${i}`,
        type: "token",
        messageId: "message-1",
        createdAt: 1000,
        data: JSON.stringify({
          type: "token",
          content,
          messageId: "message-1",
          sandboxId: "sandbox-1",
          timestamp: 1,
        }),
      });
  }

  it("bounds heavy replay and every history page without losing tied-timestamp events", () => {
    seed(40, "x".repeat(32768));
    const replay = stream.getReplay();
    expect(replay.events.length).toBeLessThan(10);
    expect(replay.events.at(-1)?.eventId).toBe("event-39");
    let cursor = replay.cursor;
    let hasMore = replay.hasMore;
    const ids = replay.events.map((row) => row.eventId);
    while (hasMore) {
      const page = stream.getHistoryPage({ cursor: cursor!, limit: 200 });
      expect(page.items.length).toBeGreaterThan(0);
      expect(page.items.length).toBeLessThan(10);
      ids.unshift(...page.items.map((row) => row.eventId));
      cursor = page.cursor;
      hasMore = page.hasMore;
    }
    expect(ids).toEqual(Array.from({ length: 40 }, (_, i) => `event-${i}`));
  });

  it("preserves small pages and permits one oversized event so history progresses", () => {
    seed(2, "small");
    expect(stream.getReplay().events).toHaveLength(2);
    expect(stream.getReplay().hasMore).toBe(false);
    repository.createEvent({
      id: 'oversized:"😀',
      type: "token",
      messageId: "message-1",
      createdAt: 2000,
      data: JSON.stringify({
        type: "token",
        content: "😀".repeat(100000),
        messageId: "message-1",
        sandboxId: "s",
        timestamp: 2,
      }),
    });
    const replay = stream.getReplay();
    expect(replay.events.map((row) => row.eventId)).toEqual(['oversized:"😀']);
    expect(replay.hasMore).toBe(true);
    const page = stream.getHistoryPage({ cursor: replay.cursor! });
    expect(page.items.map((row) => row.eventId)).toEqual(["event-0", "event-1"]);
    expect(page.hasMore).toBe(false);
  });

  it("budgets UTF-8 bytes rather than JavaScript string length", () => {
    seed(10, "😀".repeat(16384));
    expect(stream.getReplay().events).toHaveLength(3);
  });

  it.each([5, 150000])(
    "preserves legacy ID order across history and event-list pages (payload length %i)",
    (contentLength) => {
      const content = "x".repeat(contentLength);
      for (const id of ["y", "a", "w", "x"]) {
        repository.createEvent({
          id,
          type: "token",
          messageId: "message-1",
          createdAt: 1000,
          data: JSON.stringify({
            type: "token",
            content,
            messageId: "message-1",
            sandboxId: "s",
            timestamp: 1000,
          }),
        });
      }
      let cursor: EventStreamCursor | null = { timestamp: 1000, id: "z" };
      const historyIds: string[] = [];
      for (let remaining = 4; cursor && remaining > 0; remaining--) {
        const page = stream.getHistoryPage({ cursor, limit: 2 });
        historyIds.unshift(...page.items.map((item) => item.eventId));
        expect(page.cursor).not.toHaveProperty("sequence");
        cursor = page.hasMore ? page.cursor : null;
      }
      expect(cursor).toBeNull();
      expect(historyIds).toEqual(["a", "w", "x", "y"]);

      let rawCursor: string | undefined = "1000:z";
      const listIds: string[] = [];
      for (let remaining = 4; rawCursor && remaining > 0; remaining--) {
        const parsed = parseEventListCursor(rawCursor);
        if (!parsed.ok) throw new Error(parsed.error);
        const page = stream.listEvents({
          cursor: parsed.cursor,
          limit: 2,
          type: null,
          messageId: null,
        });
        listIds.push(...page.events.map((event) => event.id));
        expect(page.cursor).toMatch(/^1000:[a-z]$/);
        rawCursor = page.hasMore ? page.cursor : undefined;
      }
      expect(rawCursor).toBeUndefined();
      expect(listIds).toEqual(["y", "x", "w", "a"]);
    }
  );

  it("advances past oversized malformed storage rows even when the visible page is empty", () => {
    seed(2, "small");
    repository.createEvent({
      id: "bad",
      type: "token",
      data: "{".repeat(300000),
      messageId: null,
      createdAt: 2000,
    });
    const replay = stream.getReplay();
    expect(replay.events).toEqual([]);
    expect(replay.hasMore).toBe(true);
    expect(replay.cursor).toMatchObject({ id: "bad", timestamp: 2000 });
    const page = stream.getHistoryPage({ cursor: replay.cursor as EventStreamCursor });
    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(false);
  });
});
