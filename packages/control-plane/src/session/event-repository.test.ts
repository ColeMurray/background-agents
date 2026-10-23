import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import {
  EventRepository,
  MAX_RECOVERY_CONTEXT_CHARS,
  MAX_RECOVERY_CONTEXT_MESSAGES,
} from "./event-repository";
import { initSchema } from "./schema";
import type { SqlStorage } from "./sql-storage";

describe("conversation recovery from durable events", () => {
  let db: DatabaseSync;
  let events: EventRepository;
  let sql: SqlStorage;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(db);
    sql = storage.sql;
    initSchema(storage.sql);
    events = new EventRepository(storage.sql, storage.transactionSync);
  });

  afterEach(() => db.close());

  function user(id: string, content: string, createdAt = 1000) {
    events.createEvent({
      id: `user:${id}`,
      type: "user_message",
      messageId: id,
      data: JSON.stringify({ type: "user_message", content }),
      createdAt,
    });
  }

  function token(id: string, content: string, partId?: string) {
    events.upsertTokenEvent(
      id,
      {
        type: "token",
        messageId: id,
        sandboxId: "old-sandbox",
        timestamp: 1,
        content,
        ...(partId ? { partId } : {}),
      },
      1000
    );
  }

  it("recovers multi-turn decisions in timeline order without duplicate token updates", () => {
    user("first", "Use X, never Y.");
    token("first", "I will");
    token("first", "I will implement X in parser.py.");
    user("second", "Keep its existing API.");
    token("second", "I checked the API.", "part-1");
    token("second", "The signature will stay.", "part-2");
    // A failed send can leave a durable current user event. Never echo it back.
    user("current", "Continue.");
    events.createEvent({
      id: "tool",
      type: "tool_call",
      data: JSON.stringify({ output: "raw file" }),
      messageId: "second",
      createdAt: 1000,
    });

    expect(events.getRecoveryContext("current")).toEqual({
      messages: [
        { role: "user", content: "Use X, never Y." },
        { role: "assistant", content: "I will implement X in parser.py." },
        { role: "user", content: "Keep its existing API." },
        { role: "assistant", content: "I checked the API." },
        { role: "assistant", content: "The signature will stay." },
      ],
      truncated: false,
    });
  });

  it("returns no fallback for an initial prompt", () => {
    expect(events.getRecoveryContext("initial")).toEqual({ messages: [], truncated: false });
  });

  it("bounds the latest text and reports omitted older context", () => {
    user("old", "An older decision.", 1);
    user("large", "x".repeat(MAX_RECOVERY_CONTEXT_CHARS + 10));
    const context = events.getRecoveryContext("current");
    expect(context).toEqual({
      messages: [{ role: "user", content: "x".repeat(MAX_RECOVERY_CONTEXT_CHARS) }],
      truncated: true,
    });
  });

  it("bounds the number of events even for many small messages", () => {
    for (let i = 0; i <= MAX_RECOVERY_CONTEXT_MESSAGES; i++) user(`m${i}`, `${i}`);
    const context = events.getRecoveryContext("current");
    expect(context.messages).toHaveLength(MAX_RECOVERY_CONTEXT_MESSAGES);
    expect(context.messages[0].content).toBe("1");
    expect(context.messages.at(-1)?.content).toBe(`${MAX_RECOVERY_CONTEXT_MESSAGES}`);
    expect(context.truncated).toBe(true);
  });

  it("does not split a Unicode surrogate pair at the text budget", () => {
    user("unicode", "😀" + "x".repeat(MAX_RECOVERY_CONTEXT_CHARS - 1));
    const context = events.getRecoveryContext("current");
    expect(context.messages[0].content).toHaveLength(MAX_RECOVERY_CONTEXT_CHARS - 1);
    expect(context.messages[0].content[0]).toBe("x");
    expect(context.truncated).toBe(true);
  });

  it("retains a decision at the end of an oversized assistant event", () => {
    token("latest", "x".repeat(MAX_RECOVERY_CONTEXT_CHARS) + "Use X");
    const context = events.getRecoveryContext("current");
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe("assistant");
    expect(context.messages[0].content).toHaveLength(MAX_RECOVERY_CONTEXT_CHARS);
    expect(context.messages[0].content.endsWith("Use X")).toBe(true);
    expect(context.truncated).toBe(true);
  });

  it("keeps the suffix when newer text has already spent part of the budget", () => {
    user("older", "x".repeat(MAX_RECOVERY_CONTEXT_CHARS) + "Use X", 1);
    user("newer", "Continue.", 2);
    const context = events.getRecoveryContext("current");
    expect(context.messages[0].content.endsWith("Use X")).toBe(true);
    expect(context.messages.map(({ content }) => content).join("")).toHaveLength(
      MAX_RECOVERY_CONTEXT_CHARS
    );
    expect(context.truncated).toBe(true);
  });

  it("bounds extracted text by the total budget even with many large events", () => {
    for (let i = 0; i < MAX_RECOVERY_CONTEXT_MESSAGES; i++) {
      user(`large-${i}`, "x".repeat(MAX_RECOVERY_CONTEXT_CHARS + 10));
    }
    const read = vi.spyOn(sql, "exec");
    events.getRecoveryContext("current");
    const rows = read.mock.results[0].value.toArray() as Array<{ content: string | null }>;
    expect(rows.reduce((total, row) => total + (row.content?.length ?? 0), 0)).toBeLessThanOrEqual(
      MAX_RECOVERY_CONTEXT_CHARS + 1
    );
  });

  it("selects the newest recovery rows through a chronological index", () => {
    const read = vi.spyOn(sql, "exec");
    events.getRecoveryContext("current");
    const [query, ...params] = read.mock.calls[0];
    const plan = sql.exec(`EXPLAIN QUERY PLAN ${query}`, ...params).toArray() as Array<{
      detail: string;
    }>;
    expect(plan.some(({ detail }) => detail.includes("idx_events_recovery_chronology"))).toBe(true);
    expect(plan.some(({ detail }) => detail.includes("idx_events_type"))).toBe(false);
  });

  it("limits candidate rows before parsing older JSON payloads", () => {
    events.createEvent({
      id: "old-malformed",
      type: "token",
      messageId: "old",
      data: "invalid legacy payload",
      createdAt: 1,
    });
    for (let i = 0; i <= MAX_RECOVERY_CONTEXT_MESSAGES; i++) user(`valid-${i}`, "valid");
    expect(() => events.getRecoveryContext("current")).not.toThrow();
  });
});
