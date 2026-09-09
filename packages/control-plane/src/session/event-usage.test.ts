import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { EventRepository } from "./event-repository";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";

describe("session token usage", () => {
  let db: DatabaseSync;
  let repository: EventRepository;
  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(db);
    storage.sql.exec(
      `CREATE TABLE events (id TEXT PRIMARY KEY, type TEXT, data TEXT, message_id TEXT, created_at INTEGER, timeline_sequence INTEGER)`
    );
    repository = new EventRepository(storage.sql, storage.transactionSync);
  });
  afterEach(() => db.close());
  const step = (
    overrides: Partial<Extract<SandboxEvent, { type: "step_finish" }>> = {}
  ): Extract<SandboxEvent, { type: "step_finish" }> => ({
    type: "step_finish",
    sandboxId: "sandbox",
    messageId: "message",
    timestamp: 1,
    stepId: "step",
    ...overrides,
  });

  it("records usage without cost and replaces repeated reports of the same step", () => {
    expect(repository.getTotalTokens()).toBeNull();
    repository.recordStepUsage(
      step({ tokens: { input: 100, output: 20, reasoning: 10, cache: { read: 50, write: 5 } } }),
      1
    );
    expect(repository.getTotalTokens()).toBe(185);
    repository.recordStepUsage(step({ tokens: 200 }), 2);
    repository.recordStepUsage(step({ tokens: 200 }), 3);
    expect(repository.getTotalTokens()).toBe(200);
    repository.recordStepUsage(
      step({ stepId: "next", tokens: { total: 30, input: 20, output: 10 } }),
      4
    );
    repository.recordStepUsage(step({ messageId: "second-turn", tokens: 40 }), 5);
    repository.recordStepUsage(step({ childSessionId: "child", tokens: 50 }), 6);
    expect(repository.getTotalTokens()).toBe(320);
  });

  it("distinguishes missing, invalid, and zero usage and ignores reports without step identity", () => {
    repository.recordStepUsage(step(), 1);
    repository.recordStepUsage(step({ tokens: -1 }), 2);
    expect(repository.getTotalTokens()).toBeNull();
    repository.recordStepUsage(step({ tokens: 0 }), 3);
    expect(repository.getTotalTokens()).toBe(0);
    repository.recordStepUsage(step({ stepId: undefined, tokens: 10 }), 4);
    repository.recordStepUsage(step({ stepId: undefined, tokens: 20 }), 5);
    expect(repository.getTotalTokens()).toBe(0);
  });
});
