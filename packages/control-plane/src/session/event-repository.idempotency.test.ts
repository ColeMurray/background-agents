import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { EventRepository } from "./event-repository";
import { initSchema } from "./schema";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

describe("EventRepository projection idempotency", () => {
  it("reports a repeated canonical tool snapshot as unchanged", () => {
    const database = new DatabaseSync(":memory:");
    databases.push(database);
    const storage = createNodeSqlStorage(database);
    initSchema(storage.sql);
    const events = new EventRepository(storage.sql, storage.transactionSync);
    const event = {
      type: "tool_call" as const,
      sandboxId: "pi:session-1",
      timestamp: 1,
      messageId: "message-1",
      tool: "read",
      args: { path: "README.md" },
      callId: "call-1",
      status: "completed",
      output: "done",
    };

    expect(events.upsertToolCallEvent("message-1", event, 1)).toBe(true);
    expect(events.upsertToolCallEvent("message-1", event, 2)).toBe(false);
  });
});
