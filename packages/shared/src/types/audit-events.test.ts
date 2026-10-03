import { describe, expect, it } from "vitest";
import {
  AUDIT_OBSERVATION_ACTIONS,
  AUDIT_OPERATION_ACTIONS,
  AUTHORIZATION_DECISION_ACTIONS,
  AUTHORIZATION_DECISION_METADATA_SCHEMA,
  auditOperationResultSchema,
  interpretAuditEvent,
} from "./audit-events";

describe("interpretAuditEvent", () => {
  it("keeps shadow observations separate from operation actions", () => {
    expect(AUDIT_OBSERVATION_ACTIONS).toContain("session.shadow_denied");
    expect(AUDIT_OPERATION_ACTIONS).not.toContain("session.shadow_denied");
  });

  it.each(auditOperationResultSchema.options)(
    "interprets a shadow denial as an observation regardless of stored result %s",
    (operationResult) => {
      expect(
        interpretAuditEvent({
          action: "session.shadow_denied",
          operationResult,
          metadata: { before: {}, requested: {}, after: {}, channel: "ws" },
        })
      ).toEqual({ kind: "observation", observation: "would_deny" });
    }
  );

  it.each(["session.shadow_denied.extra", "custom.session.shadow_denied"])(
    "does not interpret lookalike action %s as an observation",
    (action) => {
      expect(interpretAuditEvent({ action, operationResult: "applied", metadata: {} })).toEqual({
        kind: "unknown",
      });
    }
  );

  it.each(AUDIT_OPERATION_ACTIONS)("preserves the domain outcome for %s", (action) => {
    for (const operationResult of auditOperationResultSchema.options) {
      expect(interpretAuditEvent({ action, operationResult, metadata: {} })).toEqual({
        kind: "operation",
        result: operationResult,
      });
    }
  });

  it.each([
    { action: AUTHORIZATION_DECISION_ACTIONS.allowed, decision: "allowed", httpStatus: 409 },
    { action: AUTHORIZATION_DECISION_ACTIONS.denied, decision: "denied", httpStatus: 403 },
  ])(
    "preserves the action-based decision and HTTP status for $action",
    ({ action, decision, httpStatus }) => {
      for (const operationResult of auditOperationResultSchema.options) {
        expect(
          interpretAuditEvent({
            action,
            operationResult,
            metadata: {
              schema: AUTHORIZATION_DECISION_METADATA_SCHEMA,
              httpMethod: "PUT",
              httpPath: "/workspace/members/user-2/role",
              httpStatus,
              requirements: [],
            },
          })
        ).toEqual({ kind: "authorization_decision", decision, httpStatus });
      }
    }
  );
});
