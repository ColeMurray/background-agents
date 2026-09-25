import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { UsageRepository } from "./usage-repository";

describe("UsageRepository", () => {
  let db: DatabaseSync;
  let usage: UsageRepository;

  beforeEach(() => {
    db = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(db);
    initSchema(storage.sql);
    usage = new UsageRepository(storage.sql, storage.transactionSync);
    db.exec(
      "INSERT INTO session (id, model, harness, created_at, updated_at) VALUES ('s', 'default-model', 'opencode', 1, 1)"
    );
    db.exec("INSERT INTO participants (id, user_id, joined_at) VALUES ('p', 'user', 1)");
    db.exec(
      "INSERT INTO messages (id, author_id, content, source, model, created_at) VALUES ('m', 'p', 'prompt', 'web', 'override-model', 1)"
    );
  });

  afterEach(() => db.close());

  it("returns null sums and zero rows before any usage is recorded", () => {
    expect(usage.getSessionTotals()).toEqual({
      rowCount: 0,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    });
  });

  it("uses the session model when the message has no override", () => {
    db.exec("UPDATE messages SET model = NULL WHERE id = 'm'");
    usage.recordStepUsage(
      { type: "step_finish", sandboxId: "s", messageId: "m", timestamp: 1 },
      "m",
      100
    );
    expect(usage.listStepUsage(null, 1).items[0]).toMatchObject({
      model: "default-model",
      harness: "opencode",
    });
  });

  it("records normalized usage and the model and harness at write time", () => {
    usage.recordStepUsage(
      {
        type: "step_finish",
        sandboxId: "s",
        messageId: "m",
        stepId: "step-1",
        timestamp: 10,
        tokens: { input: 4, output: 0, cache: { read: 2 } },
        cost: 0.02,
        messageCostUsd: 0.5,
        isSubtask: true,
        childSessionId: "child",
        taskCallId: "call",
        reason: "done",
      },
      "m",
      1234
    );
    expect(usage.listStepUsage(null, 10).items).toEqual([
      {
        id: "step-1",
        messageId: "m",
        model: "override-model",
        harness: "opencode",
        inputTokens: 4,
        outputTokens: 0,
        reasoningTokens: null,
        cacheReadTokens: 2,
        cacheWriteTokens: null,
        totalTokens: 6,
        stepCostUsd: 0.02,
        messageCostUsd: 0.5,
        isSubtask: true,
        childSessionId: "child",
        taskCallId: "call",
        reason: "done",
        createdAt: 1234,
      },
    ]);
  });

  it("keeps unknown tokens null and does not overwrite an existing step on resend", () => {
    const event = {
      type: "step_finish" as const,
      sandboxId: "s",
      messageId: "m",
      stepId: "one",
      timestamp: 1,
    };
    usage.recordStepUsage(event, "m", 10);
    usage.recordStepUsage({ ...event, tokens: 99 }, "m", 20);
    expect(usage.getSessionTotals()).toEqual({
      rowCount: 1,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: null,
    });
    expect(usage.listStepUsage(null, 10).items[0]).toMatchObject({
      createdAt: 10,
      totalTokens: null,
    });
  });

  it("uses messageId and event timestamp when stepId is absent and sums known values", () => {
    usage.recordStepUsage(
      { type: "step_finish", sandboxId: "s", messageId: "m", timestamp: 1, tokens: 8 },
      "m",
      10
    );
    usage.recordStepUsage(
      { type: "step_finish", sandboxId: "s", messageId: "m", timestamp: 1 },
      "m",
      11
    );
    usage.recordStepUsage(
      { type: "step_finish", sandboxId: "s", messageId: "m", timestamp: 2, tokens: { input: 3 } },
      "m",
      12
    );
    expect(usage.getSessionTotals()).toEqual({
      rowCount: 2,
      inputTokens: 3,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 11,
    });
    expect(usage.listStepUsage(null, 10).items.map((row) => row.id)).toEqual(["m:1", "m:2"]);
  });

  it("pages rows with equal timestamps without skips or repeats", () => {
    for (const id of ["c", "a", "b"]) {
      usage.recordStepUsage(
        { type: "step_finish", sandboxId: "s", messageId: "m", stepId: id, timestamp: 1 },
        "m",
        100
      );
    }
    const first = usage.listStepUsage(null, 2);
    expect(first.items.map((row) => row.id)).toEqual(["a", "b"]);
    expect(first.nextCursor).toEqual({ createdAt: 100, id: "b" });
    expect(usage.listStepUsage(first.nextCursor, 2)).toMatchObject({
      items: [expect.objectContaining({ id: "c" })],
      nextCursor: null,
    });
  });

  it("rejects malformed persisted rows", () => {
    usage.recordStepUsage(
      { type: "step_finish", sandboxId: "s", messageId: "m", timestamp: 1 },
      "m",
      100
    );
    db.exec("UPDATE step_usage SET input_tokens = 'corrupt'");
    expect(() => usage.listStepUsage(null, 10)).toThrow("Malformed persisted step usage row");
  });
});
