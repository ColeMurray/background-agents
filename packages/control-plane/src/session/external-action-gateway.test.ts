import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import { ExternalActionGateway, type ExternalActionExecutor } from "./external-action-gateway";

const request = {
  toolCallId: "call-1",
  idempotencyKey: "pi:message-1:call-1",
  provider: "fake",
  action: "publish_comment",
  summary: "Publish a review comment",
  target: { repository: "acme/widgets", issue: 42 },
  arguments: { body: "Looks good" },
};

function fakeExecutor(): ExternalActionExecutor & {
  execute: ReturnType<typeof vi.fn<ExternalActionExecutor["execute"]>>;
  status: ReturnType<typeof vi.fn<ExternalActionExecutor["status"]>>;
} {
  return {
    execute: vi.fn(async () => ({ kind: "succeeded", publicResult: { commentId: 7 } })),
    status: vi.fn(async () => ({ kind: "succeeded", publicResult: { commentId: 7 } })),
  };
}

describe("ExternalActionGateway", () => {
  let sqlite: DatabaseSync;
  let now: number;
  let gateway: ExternalActionGateway;

  beforeEach(() => {
    sqlite = new DatabaseSync(":memory:");
    const storage = createNodeSqlStorage(sqlite);
    initSchema(storage.sql);
    now = 1_000;
    let nextActionId = 1;
    gateway = new ExternalActionGateway(storage.sql, storage.transactionSync, {
      now: () => now,
      generateId: () => `action-${nextActionId++}`,
      generateLeaseToken: () => "lease-1",
    });
  });

  afterEach(() => sqlite.close());

  it("deduplicates a prepared action and rejects idempotency-key drift", async () => {
    const first = await gateway.prepare("session-1", "message-1", request);
    const duplicate = await gateway.prepare("session-1", "message-1", request);

    expect(duplicate).toEqual(first);
    await expect(
      gateway.prepare("session-1", "message-1", {
        ...request,
        arguments: { body: "Changed after retry" },
      })
    ).rejects.toThrow("idempotency key was reused");
    expect(gateway.status(first.id).history.map((entry) => entry.event)).toEqual(["prepared"]);
  });

  it("requires approval and executes an approved action exactly once", async () => {
    const action = await gateway.prepare("session-1", "message-1", request);
    const executor = fakeExecutor();

    await expect(gateway.execute(action.id, executor)).rejects.toThrow("not approved");
    gateway.approve(action.id, {
      source: "human",
      actorId: "user-1",
      grantId: null,
    });

    const completed = await gateway.execute(action.id, executor);
    const duplicate = await gateway.execute(action.id, executor);

    expect(completed.state).toBe("succeeded");
    expect(completed.publicResult).toEqual({ commentId: 7 });
    expect(duplicate).toEqual(completed);
    expect(executor.execute).toHaveBeenCalledOnce();
    expect(gateway.status(action.id).history.map((entry) => entry.event)).toEqual([
      "prepared",
      "approved",
      "execution_claimed",
      "execution_succeeded",
    ]);
  });

  it("binds a new call server-side to an exact previously approved effect", async () => {
    const first = await gateway.prepare("session-1", "message-1", request);
    gateway.approve(first.id, { source: "human", actorId: "user-1", grantId: null });

    const continuation = await gateway.prepare("session-1", "message-2", {
      ...request,
      toolCallId: "call-2",
      idempotencyKey: "pi:message-2:call-2",
    });

    expect(continuation).toMatchObject({ id: first.id, state: "approved" });
    expect(gateway.isBoundToOperation(first.id, "message-2")).toBe(true);

    const secondIntent = await gateway.prepare("session-1", "message-new-intent", {
      ...request,
      toolCallId: "call-new-intent",
      idempotencyKey: "pi:message-new-intent:call-new-intent",
    });
    expect(secondIntent).toMatchObject({ state: "awaiting_approval" });
    expect(secondIntent.id).not.toBe(first.id);

    const changed = await gateway.prepare("session-1", "message-3", {
      ...request,
      toolCallId: "call-3",
      idempotencyKey: "pi:message-3:call-3",
      arguments: { body: "different effect" },
    });
    expect(changed).toMatchObject({ state: "awaiting_approval" });
    expect(changed.id).not.toBe(first.id);
  });

  it("never reuses a succeeded effect for a later identical user intention", async () => {
    const first = await gateway.prepare("session-1", "message-1", request, {
      source: "human",
      actorId: "user-1",
      grantId: null,
    });
    await gateway.execute(first.id, fakeExecutor());

    const later = await gateway.prepare("session-1", "message-later", {
      ...request,
      toolCallId: "call-later",
      idempotencyKey: "pi:message-later:call-later",
    });

    expect(later).toMatchObject({ state: "awaiting_approval" });
    expect(later.id).not.toBe(first.id);
  });

  it("marks a thrown dispatch indeterminate and reconciles without redispatch", async () => {
    const action = await gateway.prepare("session-1", "message-1", request, {
      source: "automation_grant",
      actorId: "user-executor",
      grantId: "grant-1",
    });
    const executor = fakeExecutor();
    executor.execute.mockRejectedValueOnce(new Error("connection reset after write"));
    executor.status.mockResolvedValueOnce({
      kind: "succeeded",
      publicResult: { commentId: 9 },
    });

    const uncertain = await gateway.execute(action.id, executor);
    expect(uncertain.state).toBe("indeterminate");

    const secondExecute = await gateway.execute(action.id, executor);
    expect(secondExecute.state).toBe("indeterminate");
    expect(executor.execute).toHaveBeenCalledOnce();

    const reconciled = await gateway.reconcile(action.id, executor);
    expect(reconciled).toMatchObject({
      state: "succeeded",
      publicResult: { commentId: 9 },
    });
    expect(executor.status).toHaveBeenCalledOnce();
  });

  it("retries only after status proves the provider never admitted the action", async () => {
    const action = await gateway.prepare("session-1", "message-1", request, {
      source: "human",
      actorId: "user-1",
      grantId: null,
    });
    const executor = fakeExecutor();
    executor.execute.mockRejectedValueOnce(new Error("ambiguous transport failure"));
    executor.status.mockResolvedValueOnce({ kind: "not_admitted" });

    expect((await gateway.execute(action.id, executor)).state).toBe("indeterminate");
    expect((await gateway.reconcile(action.id, executor)).state).toBe("approved");
    expect((await gateway.execute(action.id, executor)).state).toBe("succeeded");
    expect(executor.execute).toHaveBeenCalledTimes(2);
  });

  it("fences an expired execution lease as indeterminate before recovery", async () => {
    const action = await gateway.prepare("session-1", "message-1", request, {
      source: "human",
      actorId: "user-1",
      grantId: null,
    });
    sqlite
      .prepare(
        "UPDATE external_actions SET state = 'executing', lease_token = 'dead-worker', lease_expires_at = ? WHERE id = ?"
      )
      .run(now + 30_000, action.id);
    now += 31_000;
    const executor = fakeExecutor();

    const recovered = await gateway.execute(action.id, executor);

    expect(recovered.state).toBe("indeterminate");
    expect(executor.execute).not.toHaveBeenCalled();
  });

  it("recovers a due accepted action after a SessionDO restart", async () => {
    const action = await gateway.prepare("session-1", "message-1", request, {
      source: "human",
      actorId: "user-1",
      grantId: null,
    });
    const executor = fakeExecutor();
    executor.execute.mockResolvedValueOnce({
      kind: "accepted",
      providerReference: "provider-operation-1",
    });
    expect((await gateway.execute(action.id, executor)).state).toBe("executing");
    expect(gateway.nextReconciliationAt()).toBe(6_000);

    now = 6_000;
    const restarted = new ExternalActionGateway(
      createNodeSqlStorage(sqlite).sql,
      createNodeSqlStorage(sqlite).transactionSync,
      { now: () => now }
    );
    executor.status.mockResolvedValueOnce({
      kind: "succeeded",
      publicResult: { commentId: 11 },
    });
    await restarted.reconcileDue(() => executor);

    expect(restarted.status(action.id).action).toMatchObject({
      state: "succeeded",
      publicResult: { commentId: 11 },
    });
    expect(restarted.nextReconciliationAt()).toBeNull();
  });
});
