import { describe, expect, it } from "vitest";
import {
  MAX_AUDIT_EVENT_TIMESTAMP_MS,
  auditEventListResponseSchema,
  auditEventSchema,
} from "./audit-events";

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
