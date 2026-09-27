import { describe, expect, it } from "vitest";
import {
  AUTHORIZATION_DECISION_ACTIONS,
  AUTHORIZATION_DECISION_METADATA_SCHEMA,
  MAX_AUDIT_EVENT_TIMESTAMP_MS,
  auditEventListResponseSchema,
  auditEventSchema,
  interpretAuditEvent,
  type AuditOperationResult,
} from "./audit-events";

const RESULTS: AuditOperationResult[] = ["applied", "no_op", "denied", "rejected"];

function decisionMetadata(httpStatus: unknown) {
  return {
    schema: AUTHORIZATION_DECISION_METADATA_SCHEMA,
    httpMethod: "PUT",
    httpPath: "/workspace/members/user-2/role",
    httpStatus,
    requirements: [],
  };
}

const event = {
  id: "event-1",
  occurredAt: 123,
  requestId: "request-1",
  principalKind: "service",
  actorUserIdSnapshot: null,
  actorServiceSnapshot: "github-bot",
  action: "workspace.member_role_updated",
  resourceType: "user",
  resourceId: null,
  targetUserIdSnapshot: null,
  reasonCode: "role_replaced",
  operationResult: "applied",
  metadata: { schema: "future.v2", nested: { additions: [true, 1, null] } },
} as const;

describe("audit event contracts", () => {
  it("accepts current principals, outcomes, nullable snapshots, and forward-compatible metadata", () => {
    for (const principalKind of ["user", "service", "sandbox"]) {
      for (const operationResult of ["applied", "no_op", "denied", "rejected"]) {
        expect(auditEventSchema.parse({ ...event, principalKind, operationResult })).toMatchObject({
          principalKind,
          operationResult,
          metadata: event.metadata,
        });
      }
    }
  });

  it("rejects unsupported principal and outcome values", () => {
    expect(() => auditEventSchema.parse({ ...event, principalKind: "automation" })).toThrow();
    expect(() => auditEventSchema.parse({ ...event, operationResult: "failed" })).toThrow();
  });

  it("rejects timestamps that cannot be paginated or rendered as dates", () => {
    expect(auditEventSchema.parse({ ...event, occurredAt: MAX_AUDIT_EVENT_TIMESTAMP_MS })).toEqual({
      ...event,
      occurredAt: MAX_AUDIT_EVENT_TIMESTAMP_MS,
    });
    expect(() =>
      auditEventSchema.parse({ ...event, occurredAt: MAX_AUDIT_EVENT_TIMESTAMP_MS + 1 })
    ).toThrow();
    expect(() =>
      auditEventSchema.parse({ ...event, occurredAt: Number.MAX_SAFE_INTEGER })
    ).toThrow();
  });

  it("enforces the pagination cursor invariant", () => {
    expect(
      auditEventListResponseSchema.parse({ events: [event], hasMore: false, nextCursor: null })
    ).toMatchObject({ hasMore: false, nextCursor: null });
    expect(
      auditEventListResponseSchema.parse({ events: [event], hasMore: true, nextCursor: "opaque" })
    ).toMatchObject({ hasMore: true, nextCursor: "opaque" });
    expect(() =>
      auditEventListResponseSchema.parse({ events: [], hasMore: true, nextCursor: null })
    ).toThrow();
    expect(() =>
      auditEventListResponseSchema.parse({ events: [], hasMore: false, nextCursor: "unexpected" })
    ).toThrow();
  });
});

describe("interpretAuditEvent", () => {
  it.each(RESULTS)("derives decisions from the action, not operationResult %s", (result) => {
    for (const [decision, action] of Object.entries(AUTHORIZATION_DECISION_ACTIONS)) {
      expect(
        interpretAuditEvent({ action, operationResult: result, metadata: decisionMetadata(409) })
      ).toEqual({ kind: "authorization_decision", decision, httpStatus: 409 });
    }
  });

  it.each([
    ["legacy metadata", { legacy: true }],
    [
      "an unknown schema version",
      { ...decisionMetadata(200), schema: "authorization_decision.v2" },
    ],
    ["a missing status", { ...decisionMetadata(200), httpStatus: undefined }],
    ["an out-of-range status", decisionMetadata(99)],
    ["a non-integer status", decisionMetadata(200.5)],
    ["a string status", decisionMetadata("200")],
  ])("keeps the decision but exposes no status for %s", (_, metadata) => {
    expect(
      interpretAuditEvent({
        action: AUTHORIZATION_DECISION_ACTIONS.allowed,
        operationResult: "applied",
        metadata,
      })
    ).toEqual({ kind: "authorization_decision", decision: "allowed", httpStatus: null });
  });

  it.each(RESULTS)("passes through operation-owner result %s", (result) => {
    expect(
      interpretAuditEvent({
        action: "workspace.member_role_updated",
        operationResult: result,
        metadata: decisionMetadata(500),
      })
    ).toEqual({ kind: "operation", result });
  });

  it.each(["authorization.policy_updated", "future.request_gate", "constructor"])(
    "leaves unrecognized action %s uninterpreted, even with decision metadata",
    (action) => {
      expect(
        interpretAuditEvent({ action, operationResult: "applied", metadata: decisionMetadata(200) })
      ).toEqual({ kind: "unknown" });
    }
  );
});
