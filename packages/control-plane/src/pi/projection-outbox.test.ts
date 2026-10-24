import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { NodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { PermanentPiProjectionError, PiProjectionOutbox } from "./projection-outbox";
import { applyPiDoMigrations } from "./schema";

const databases: DatabaseSync[] = [];

afterEach(() => {
  for (const database of databases.splice(0)) database.close();
});

function buildOutbox(
  deliver: (
    sequence: number,
    displayId: string,
    operationId: string,
    event: unknown
  ) => Promise<void>
) {
  const database = new DatabaseSync(":memory:");
  databases.push(database);
  const sql = createNodeSqlStorage(database).sql;
  applyPiDoMigrations(sql);
  return new PiProjectionOutbox(new NodeSqliteDatabase(database), deliver);
}

describe("PiProjectionOutbox", () => {
  it("keeps immutable versions for streaming updates that share one display identity", async () => {
    const deliver = vi
      .fn<
        (sequence: number, displayId: string, operationId: string, event: unknown) => Promise<void>
      >()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue(undefined);
    const outbox = buildOutbox(deliver);
    const first = event("hel");
    const final = event("hello");

    const firstSequence = await outbox.enqueue("message-1:assistant", "message-1", first, 1);
    const finalSequence = await outbox.enqueue("message-1:assistant", "message-1", final, 2);

    expect(finalSequence).toBe(firstSequence + 1);
    await expect(outbox.drain("message-1")).rejects.toThrow("response lost");
    await expect(outbox.drain("message-1")).resolves.toBeUndefined();
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(deliver.mock.calls.map((call) => call[1])).toEqual([
      "message-1:assistant",
      "message-1:assistant",
      "message-1:assistant",
    ]);
    expect(deliver).toHaveBeenLastCalledWith(
      finalSequence,
      "message-1:assistant",
      "message-1",
      final
    );
    await expect(outbox.pending("message-1")).resolves.toBe(0);
  });

  it("drains an update enqueued while an earlier delivery awaits acknowledgement", async () => {
    let release: (() => void) | undefined;
    const firstDelivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delivered: string[] = [];
    const outbox = buildOutbox(async (_sequence, displayId) => {
      delivered.push(displayId);
      if (displayId === "first") await firstDelivery;
    });
    await outbox.enqueue("first", "message-1", event("first"), 1);

    const draining = outbox.drain("message-1");
    await vi.waitFor(() => expect(delivered).toEqual(["first"]));
    await outbox.enqueue("second", "message-1", event("second"), 2);
    release?.();
    await draining;

    expect(delivered).toEqual(["first", "second"]);
    await expect(outbox.pending("message-1")).resolves.toBe(0);
  });

  it("marks delivery by operation and sequence when two operations both have sequence one", async () => {
    const delivered: string[] = [];
    const outbox = buildOutbox(async (_sequence, _displayId, operationId) => {
      delivered.push(operationId);
    });
    await expect(outbox.enqueue("a", "operation-a", event("a", "operation-a"), 1)).resolves.toBe(1);
    await expect(outbox.enqueue("b", "operation-b", event("b", "operation-b"), 1)).resolves.toBe(1);

    await outbox.drain("operation-a");

    await expect(outbox.pending("operation-a")).resolves.toBe(0);
    await expect(outbox.pending("operation-b")).resolves.toBe(1);
    await outbox.drain("operation-b");
    expect(delivered).toEqual(["operation-a", "operation-b"]);
  });

  it("marks permanent failure by operation and sequence without poisoning another operation", async () => {
    const deliver = vi.fn(async (_sequence, _displayId, operationId: string) => {
      if (operationId === "operation-a") throw new PermanentPiProjectionError("rejected (409)");
    });
    const outbox = buildOutbox(deliver);
    await outbox.enqueue("a", "operation-a", event("a", "operation-a"), 1);
    await outbox.enqueue("b", "operation-b", event("b", "operation-b"), 1);

    await expect(outbox.drain("operation-a")).rejects.toThrow("rejected (409)");
    await expect(outbox.drain("operation-b")).resolves.toBeUndefined();

    expect(deliver.mock.calls.map((call) => call[2])).toEqual(["operation-a", "operation-b"]);
  });

  it("records deterministic 4xx failures permanently without repeated delivery", async () => {
    const deliver = vi.fn(async () => {
      throw new PermanentPiProjectionError("rejected (409)");
    });
    const outbox = buildOutbox(deliver);
    await outbox.enqueue("invalid", "message-1", event("invalid"), 1);

    await expect(outbox.drain("message-1")).rejects.toThrow("rejected (409)");
    await expect(outbox.drain("message-1")).rejects.toThrow("rejected (409)");
    expect(deliver).toHaveBeenCalledOnce();

    await outbox.complete("message-1");
    await expect(outbox.drain("message-1")).resolves.toBeUndefined();
  });

  it("latches one final capture across delivery cleanup and later retries", async () => {
    const outbox = buildOutbox(async () => {});
    const first = accounting(1.25, 10);
    await outbox.markFinalized("message-1", first, 1);
    await outbox.markFinalized("message-1", accounting(99, 999), 2);

    await expect(outbox.finalAccounting("message-1")).resolves.toEqual(first);
    await outbox.complete("message-1");
    await expect(outbox.isFinalized("message-1")).resolves.toBe(true);
    await expect(outbox.finalAccounting("message-1")).resolves.toEqual(first);
  });

  it("bounds finalization tombstones after terminal cleanup", async () => {
    const outbox = buildOutbox(async () => {});
    for (let index = 0; index < 130; index++) {
      const operationId = `message-${index}`;
      await outbox.markFinalized(operationId, accounting(index, index), index);
      await outbox.complete(operationId);
    }

    await expect(outbox.isFinalized("message-0")).resolves.toBe(false);
    await expect(outbox.isFinalized("message-129")).resolves.toBe(true);
  });
});

function event(content: string, messageId = "message-1") {
  return {
    type: "token" as const,
    sandboxId: "pi:s1",
    timestamp: 1,
    messageId,
    content,
    partId: "assistant",
  };
}

function accounting(costUsd: number, input: number) {
  return {
    usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, total: input },
    costUsd,
  };
}
