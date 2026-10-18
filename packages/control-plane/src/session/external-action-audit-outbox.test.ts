import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createNodeSqlStorage } from "../node/sqlite-storage";
import { ExternalActionGateway } from "./external-action-gateway";
import { ExternalActionAuditOutbox } from "./external-action-audit-outbox";
import { initSchema } from "./schema";

let database: DatabaseSync;

beforeEach(() => {
  database = new DatabaseSync(":memory:");
});
afterEach(() => database.close());

it("retries a durable human-decision audit projection until D1 acknowledges it", async () => {
  const storage = createNodeSqlStorage(database);
  initSchema(storage.sql);
  const gateway = new ExternalActionGateway(storage.sql, storage.transactionSync, {
    now: () => 1_000,
    generateId: () => "action-1",
  });
  const action = await gateway.prepare("session-1", "message-1", {
    toolCallId: "call-1",
    idempotencyKey: "pi:message-1:call-1",
    provider: "fake",
    action: "publish_comment",
    summary: "Publish comment",
    target: { issue: 42 },
    arguments: { body: "Hi" },
  });
  gateway.approve(action.id, {
    source: "human",
    actorId: "user-1",
    grantId: null,
    requestId: "request-1",
  });
  const outbox = new ExternalActionAuditOutbox(storage.sql, storage.transactionSync, () => 1_000);
  const project = vi
    .fn()
    .mockRejectedValueOnce(new Error("D1 unavailable"))
    .mockResolvedValueOnce(undefined);

  await outbox.flush(project);
  expect(outbox.nextDeadline()).toBeGreaterThan(1_000);
  expect(database.prepare("SELECT attempts FROM external_action_audit_outbox").get()).toEqual({
    attempts: 1,
  });

  await outbox.flush(project, outbox.nextDeadline()!);
  expect(database.prepare("SELECT * FROM external_action_audit_outbox").all()).toEqual([]);
  expect(project).toHaveBeenCalledTimes(2);
  expect(project.mock.calls[0][0]).toMatchObject({
    requestId: "request-1",
    actorUserId: "user-1",
    action: "external_action.approved",
    actionId: "action-1",
    beforeState: "awaiting_approval",
    afterState: "approved",
  });
});
