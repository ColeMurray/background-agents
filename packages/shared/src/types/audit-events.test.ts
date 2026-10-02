import { describe, expect, it } from "vitest";
import { interpretAuditEvent } from "./audit-events";

describe("interpretAuditEvent", () => {
  it("recognizes automation.executor_changed as a domain operation", () => {
    expect(
      interpretAuditEvent({
        action: "automation.executor_changed",
        operationResult: "applied",
        metadata: {},
      })
    ).toEqual({ kind: "operation", result: "applied" });
  });
});
