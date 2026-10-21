import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { ExternalActionGateway } from "./external-action-gateway";

const request = {
  toolCallId: "call-1",
  idempotencyKey: "key-1",
  provider: "github",
  action: "comment",
  summary: "Comment on issue 12",
  target: { owner: "acme", repo: "widgets", issue: 12 },
  arguments: { body: "hello" },
};

describe("ExternalActionGateway pending list", () => {
  let gateway: ExternalActionGateway;
  let now: number;

  beforeEach(() => {
    const sqlite = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(sqlite);
    initSchema(storage.sql);
    now = 1_000;
    let nextActionId = 1;
    gateway = new ExternalActionGateway(storage.sql, storage.transactionSync, {
      now: () => now,
      generateId: () => `action-${nextActionId++}`,
    });
  });

  it("lists an awaiting effect with its exact target and arguments", async () => {
    await gateway.prepare("session-1", "operation-1", request);
    await gateway.prepare("session-1", "operation-2", {
      ...request,
      toolCallId: "call-2",
      idempotencyKey: "key-2",
      summary: "Second comment",
      arguments: { body: "goodbye" },
    });

    const page = gateway.listPending("session-1");

    expect(page.actions).toHaveLength(2);
    expect(page.actions[0]).toMatchObject({
      provider: "github",
      action: "comment",
      summary: "Comment on issue 12",
      state: "awaiting_approval",
      target: { owner: "acme", repo: "widgets", issue: 12 },
      arguments: { body: "hello" },
      approval: null,
    });
    expect(page.nextCursor).toBeNull();
  });

  it("never lists an effect from another session", async () => {
    await gateway.prepare("session-1", "operation-1", request);
    await gateway.prepare("session-2", "operation-2", {
      ...request,
      toolCallId: "call-2",
      idempotencyKey: "key-2",
    });

    expect(gateway.listPending("session-1").actions).toHaveLength(1);
    expect(gateway.listPending("session-3").actions).toHaveLength(0);
  });
  it("drops a decided effect from the pending list", async () => {
    const action = await gateway.prepare("session-1", "operation-1", request);
    gateway.deny(action.id, "user-1", "not now");

    expect(gateway.listPending("session-1").actions).toHaveLength(0);
  });

  it("bounds the page and resumes from the cursor", async () => {
    for (let index = 0; index < 5; index += 1) {
      await gateway.prepare("session-1", `operation-${index}`, {
        ...request,
        toolCallId: `call-${index}`,
        idempotencyKey: `key-${index}`,
        arguments: { body: `body-${index}` },
      });
      now += 1;
    }

    const first = gateway.listPending("session-1", { limit: 2 });
    expect(first.actions).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = gateway.listPending("session-1", {
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(second.actions).toHaveLength(2);
    expect(second.actions[0]?.id).not.toBe(first.actions[0]?.id);

    const third = gateway.listPending("session-1", {
      limit: 2,
      cursor: second.nextCursor,
    });
    expect(third.actions).toHaveLength(1);
    expect(third.nextCursor).toBeNull();
  });

  it("ignores a malformed cursor instead of guessing a position", async () => {
    await gateway.prepare("session-1", "operation-1", request);

    expect(gateway.listPending("session-1", { cursor: "not-a-cursor" }).actions).toHaveLength(1);
  });
});
