import { describe, expect, it } from "vitest";
import { toAuditEvent, type AuditEventRow } from "./audit-event-store";

const row: AuditEventRow = {
  id: "event-1",
  occurred_at: 100,
  request_id: "request-1",
  principal_kind: "user",
  actor_user_id_snapshot: "user-1",
  actor_service_snapshot: null,
  action: "workspace.member_role_updated",
  resource_type: "user",
  resource_id: "user-2",
  target_user_id_snapshot: "user-2",
  reason_code: "role_replaced",
  operation_result: "no_op",
  metadata_json: '{"future":{"value":true}}',
};

describe("AuditEventStore boundaries", () => {
  it("maps database rows and parses metadata", () => {
    expect(toAuditEvent(row)).toEqual({
      id: "event-1",
      occurredAt: 100,
      requestId: "request-1",
      principalKind: "user",
      actorUserIdSnapshot: "user-1",
      actorServiceSnapshot: null,
      action: "workspace.member_role_updated",
      resourceType: "user",
      resourceId: "user-2",
      targetUserIdSnapshot: "user-2",
      reasonCode: "role_replaced",
      operationResult: "no_op",
      metadata: { future: { value: true } },
    });
  });
});
