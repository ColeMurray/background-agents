import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { initSchema } from "./schema";
import {
  ExternalActionGateway,
  type ExternalActionExecutionResult,
  type ExternalActionExecutor,
} from "./external-action-gateway";

const request = {
  toolCallId: "call-1",
  idempotencyKey: "pi:message-1:call-1",
  provider: "fake",
  action: "publish_comment",
  summary: "Publish a review comment",
  target: { repository: "acme/widgets", issue: 42 },
  arguments: { body: "Looks good" },
};

function fakeExecutor(
  outcome: ExternalActionExecutionResult = { kind: "succeeded", publicResult: { commentId: 7 } }
): ExternalActionExecutor {
  return {
    execute: vi.fn(async () => outcome),
    status: vi.fn(async () => ({ kind: "succeeded" as const, publicResult: { commentId: 7 } })),
  };
}

describe("ExternalActionGateway lifecycle", () => {
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

  function auditRows(): Array<{
    actor_kind: string;
    actor_user_id: string;
    occurred_at: number | null;
    action: string;
  }> {
    return sqlite
      .prepare(
        "SELECT actor_kind, actor_user_id, occurred_at, action FROM external_action_audit_outbox"
      )
      .all() as unknown as Array<{
      actor_kind: string;
      actor_user_id: string;
      occurred_at: number | null;
      action: string;
    }>;
  }

  it("joins an identical pending effect instead of raising a second approval", async () => {
    const first = await gateway.prepare("session-1", "message-1", request);
    const second = await gateway.prepare("session-1", "message-2", {
      ...request,
      toolCallId: "call-2",
      idempotencyKey: "pi:message-2:call-2",
    });

    expect(second.id).toBe(first.id);
    expect(second.state).toBe("awaiting_approval");
    expect(gateway.listPending("session-1").actions).toHaveLength(1);
    expect(gateway.isBoundToOperation(first.id, "message-2")).toBe(true);
  });

  it("joins an identical running effect so one effect is never written twice", async () => {
    const first = await gateway.prepare("session-1", "message-1", request);
    gateway.approve(first.id, { source: "human", actorId: "user-1", grantId: null });
    const executor = fakeExecutor({ kind: "accepted", providerReference: "ref-1" });
    await gateway.execute(first.id, executor);

    const second = await gateway.prepare("session-1", "message-2", {
      ...request,
      toolCallId: "call-2",
      idempotencyKey: "pi:message-2:call-2",
    });

    expect(second.id).toBe(first.id);
    expect(executor.execute).toHaveBeenCalledOnce();
  });

  it("rearms the continuation after a definitive not-admitted result", async () => {
    const first = await gateway.prepare("session-1", "message-1", request);
    gateway.approve(first.id, { source: "human", actorId: "user-1", grantId: null });
    const continuation = await gateway.prepare("session-1", "message-2", {
      ...request,
      toolCallId: "call-2",
      idempotencyKey: "pi:message-2:call-2",
    });
    expect(continuation.id).toBe(first.id);

    const executor: ExternalActionExecutor = {
      execute: vi.fn(async () => ({ kind: "accepted" as const, providerReference: "ref-1" })),
      status: vi.fn(async () => ({ kind: "not_admitted" as const })),
    };
    await gateway.execute(first.id, executor);
    const reconciled = await gateway.reconcile(first.id, executor);

    expect(reconciled.state).toBe("approved");
    expect(reconciled.error).toBeNull();

    // The approval that authorized the effect is still valid, so a later
    // identical attempt may use it again instead of demanding a new one.
    const later = await gateway.prepare("session-1", "message-3", {
      ...request,
      toolCallId: "call-3",
      idempotencyKey: "pi:message-3:call-3",
    });
    expect(later.id).toBe(first.id);
    expect(later.state).toBe("approved");
  });

  it("refuses an approval whose provenance is ambiguous", async () => {
    const action = await gateway.prepare("session-1", "message-1", request);

    expect(() =>
      gateway.approve(action.id, {
        source: "human",
        actorId: "user-1",
        grantId: "grant-1",
      })
    ).toThrow("cannot carry an automation grant");
    expect(() =>
      gateway.approve(action.id, { source: "automation_grant", actorId: "user-1", grantId: null })
    ).toThrow("must name its grant");
    expect(gateway.status(action.id).action.state).toBe("awaiting_approval");
  });

  it("cancels an approved effect that nobody wanted", async () => {
    const action = await gateway.prepare("session-1", "message-1", request);
    gateway.approve(action.id, { source: "human", actorId: "user-1", grantId: null });

    const cancelled = gateway.cancel(action.id, "user-1", "Superseded");

    expect(cancelled.state).toBe("cancelled");
    expect(gateway.status(action.id).history.map((entry) => entry.event)).toEqual([
      "prepared",
      "approved",
      "cancelled",
    ]);
  });

  it("refuses to cancel an effect the provider may already have applied", async () => {
    const action = await gateway.prepare("session-1", "message-1", request);
    gateway.approve(action.id, { source: "human", actorId: "user-1", grantId: null });
    const executor = fakeExecutor({ kind: "accepted", providerReference: "ref-1" });
    await gateway.execute(action.id, executor);

    expect(() => gateway.cancel(action.id, "user-1", "Too late")).toThrow(
      "cannot be cancelled from executing"
    );
  });

  it("expires a pending approval that nobody acted on", async () => {
    const action = await gateway.prepare("session-1", "message-1", request, undefined, {
      expiresAt: now + 500,
    });
    expect(action.expiresAt).toBe(now + 500);
    expect(gateway.nextExpiryAt()).toBe(now + 500);

    now += 500;
    const expired = gateway.expireDue("session-1");

    expect(expired).toHaveLength(1);
    expect(expired[0]?.state).toBe("cancelled");
    expect(gateway.listPending("session-1").actions).toHaveLength(0);
    expect(gateway.nextExpiryAt()).toBeNull();
  });

  it("refuses to approve an approval that already expired", async () => {
    const action = await gateway.prepare("session-1", "message-1", request, undefined, {
      expiresAt: now + 100,
    });
    now += 100;

    expect(() =>
      gateway.approve(action.id, { source: "human", actorId: "user-1", grantId: null })
    ).toThrow("expired");
  });

  it("expires only the pending approvals of the session that owns them", async () => {
    await gateway.prepare("session-1", "message-1", request, undefined, { expiresAt: now + 10 });
    await gateway.prepare(
      "session-2",
      "message-2",
      { ...request, idempotencyKey: "pi:message-2:call-1" },
      undefined,
      { expiresAt: now + 10 }
    );

    now += 10;
    expect(gateway.expireDue("session-1")).toHaveLength(1);
    expect(gateway.listPending("session-2").actions).toHaveLength(1);
  });

  it("records the decision time on the audit event, not the flush time", async () => {
    const action = await gateway.prepare("session-1", "message-1", request);
    const decisionAt = now;
    gateway.approve(action.id, { source: "human", actorId: "user-1", grantId: null });
    // The projection is flushed later. The audit event must still say when
    // the decision happened.
    now += 60_000;

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurred_at).toBe(decisionAt);
    expect(rows[0]?.actor_kind).toBe("user");
  });

  it("attributes a system expiry to a service, never to a user", async () => {
    await gateway.prepare("session-1", "message-1", request, undefined, { expiresAt: now + 10 });
    now += 10;
    gateway.expireDue("session-1");

    const rows = auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_kind).toBe("service");
    expect(rows[0]?.actor_user_id).toBe("external-action-expiry");
  });
});
