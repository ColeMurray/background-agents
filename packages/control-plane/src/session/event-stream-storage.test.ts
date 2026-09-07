import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { EventRepository } from "./event-repository";
import { SessionEventStream, type EventStreamCursor } from "./event-stream";
import { initSchema } from "./schema";

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
