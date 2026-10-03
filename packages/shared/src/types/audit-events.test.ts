import { describe, expect, it } from "vitest";
import { interpretAuditEvent } from "./audit-events";

describe("interpretAuditEvent", () => {
  it("recognizes a shadow denial without claiming an HTTP authorization decision", () => {
    expect(
      interpretAuditEvent({
        action: "session.shadow_denied",
        operationResult: "denied",
        metadata: { before: {}, requested: {}, after: {}, channel: "ws" },
      })
    ).toEqual({ kind: "operation", result: "denied" });
  });

  it.each(["automation.executor_changed", "team.binding_added", "team.binding_removed"])(
    "recognizes %s as a domain operation",
    (action) => {
      expect(interpretAuditEvent({ action, operationResult: "applied", metadata: {} })).toEqual({
        kind: "operation",
        result: "applied",
      });
    }
  );
});
