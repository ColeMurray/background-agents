import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { UsageRepository } from "./usage-repository";

const pricing = {
  source: "models.dev" as const,
  model: "gpt-6.1-sol",
  rates: {
    input: 2,
    output: 10,
    cache_read: 0.2,
    cache_write: 2,
    tiers: [{ context: 200000, input: 4, output: 15 }],
  },
};

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
    expect(usage.listStepUsage(null, 1).items[0]).not.toHaveProperty("pricing");
    expect(db.prepare("SELECT pricing_json FROM step_usage").get()).toEqual({ pricing_json: null });
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
        pricing,
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
        pricing,
        isSubtask: true,
        childSessionId: "child",
        taskCallId: "call",
        reason: "done",
        createdAt: 1234,
      },
    ]);
  });

  it("records negative or non-finite step costs as unknown, but preserves zero", () => {
    for (const [stepId, cost] of [
      ["negative", -0.05],
      ["non-finite", Number.POSITIVE_INFINITY],
      ["zero", 0],
    ] as const) {
      usage.recordStepUsage(
        { type: "step_finish", sandboxId: "s", messageId: "m", stepId, timestamp: 1, cost },
        "m",
        100
      );
    }
    expect(
      usage.listStepUsage(null, 10).items.map(({ id, stepCostUsd }) => [id, stepCostUsd])
    ).toEqual([
      ["zero", 0],
      ["non-finite", null],
      ["negative", null],
    ]);
  });

  it("updates a corrected step without adding a row or moving its pagination timestamp", () => {
    const event = {
      type: "step_finish" as const,
      sandboxId: "s",
      messageId: "m",
      stepId: "one",
      timestamp: 1,
    };
    usage.recordStepUsage({ ...event, pricing }, "m", 10);
    const corrected = {
      ...event,
      tokens: 99,
      cost: 0.25,
      reason: "corrected",
      pricing: { ...pricing, rates: { ...pricing.rates, input: 3 } },
    };
    usage.recordStepUsage(corrected, "m", 20);
    expect(usage.getSessionTotals()).toEqual({
      rowCount: 1,
      inputTokens: null,
      outputTokens: null,
      reasoningTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      totalTokens: 99,
    });
    expect(usage.listStepUsage(null, 10).items[0]).toMatchObject({
      createdAt: 10,
      totalTokens: 99,
      stepCostUsd: 0.25,
      reason: "corrected",
      pricing: corrected.pricing,
    });
    usage.recordStepUsage(corrected, "m", 30);
    expect(usage.getSessionTotals().rowCount).toBe(1);
    expect(usage.listStepUsage(null, 10).items[0].createdAt).toBe(10);
    expect(usage.listStepUsage(null, 10).items[0].pricing).toEqual(corrected.pricing);
  });

  it("does not retain a stale snapshot when a corrected step is unpriced", () => {
    const event = {
      type: "step_finish" as const,
      sandboxId: "s",
      messageId: "m",
      stepId: "one",
      timestamp: 1,
    };
    usage.recordStepUsage({ ...event, cost: 0.25, pricing }, "m", 10);
    usage.recordStepUsage({ ...event, cost: null }, "m", 20);
    const [row] = usage.listStepUsage(null, 10).items;
    expect(row.stepCostUsd).toBeNull();
    expect(row).not.toHaveProperty("pricing");
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
    expect(usage.listStepUsage(null, 10).items.map((row) => row.id)).toEqual(["m:2", "m:1"]);
  });

  it("pages rows newest first, with equal timestamps, without skips or repeats", () => {
    for (const id of ["c", "a", "b"]) {
      usage.recordStepUsage(
        { type: "step_finish", sandboxId: "s", messageId: "m", stepId: id, timestamp: 1 },
        "m",
        100
      );
    }
    const first = usage.listStepUsage(null, 2);
    expect(first.items.map((row) => row.id)).toEqual(["c", "b"]);
    expect(first.nextCursor).toEqual({ createdAt: 100, id: "b" });
    expect(usage.listStepUsage(first.nextCursor, 2)).toMatchObject({
      items: [expect.objectContaining({ id: "a" })],
      nextCursor: null,
    });
  });

  it("keeps rows recorded after the first page out of later pages", () => {
    for (const [stepId, createdAt] of [
      ["old", 100],
      ["new", 200],
    ] as const) {
      usage.recordStepUsage(
        { type: "step_finish", sandboxId: "s", messageId: "m", stepId, timestamp: 1 },
        "m",
        createdAt
      );
    }
    const first = usage.listStepUsage(null, 1);
    usage.recordStepUsage(
      { type: "step_finish", sandboxId: "s", messageId: "m", stepId: "later", timestamp: 1 },
      "m",
      300
    );

    expect(usage.listStepUsage(first.nextCursor, 10)).toMatchObject({
      items: [expect.objectContaining({ id: "old" })],
      nextCursor: null,
    });
  });

  it("rejects invalid limits and cursors before querying", () => {
    usage.recordStepUsage(
      { type: "step_finish", sandboxId: "s", messageId: "m", timestamp: 1 },
      "m",
      100
    );
    for (const limit of [0, -1, 1.5, Number.NaN, 101]) {
      expect(() => usage.listStepUsage(null, limit)).toThrow("Invalid step usage limit");
    }
    for (const cursor of [
      { createdAt: -1, id: "m:1" },
      { createdAt: Number.NaN, id: "m:1" },
      { createdAt: 100, id: "" },
    ]) {
      expect(() => usage.listStepUsage(cursor, 1)).toThrow("Invalid step usage cursor");
    }
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

  it.each(["not-json", "null", JSON.stringify({ ...pricing, rates: [] })])(
    "rejects malformed persisted pricing %s",
    (value) => {
      usage.recordStepUsage(
        { type: "step_finish", sandboxId: "s", messageId: "m", timestamp: 1 },
        "m",
        100
      );
      db.prepare("UPDATE step_usage SET pricing_json = ?").run(value);
      expect(() => usage.listStepUsage(null, 10)).toThrow("Malformed persisted step usage pricing");
    }
  );

  it.each(["id = ''", "created_at = -1", "created_at = 1.5"])(
    "rejects a persisted row whose key cannot continue a page (%s)",
    (assignment) => {
      usage.recordStepUsage(
        { type: "step_finish", sandboxId: "s", messageId: "m", timestamp: 1 },
        "m",
        100
      );
      db.exec(`UPDATE step_usage SET ${assignment}`);
      expect(() => usage.listStepUsage(null, 10)).toThrow("Malformed persisted step usage row");
    }
  );
});
