import { describe, expect, it } from "vitest";
import { externalActionApprovalSchema } from "./external-actions";

describe("externalActionApprovalSchema", () => {
  it("accepts a human approval without a grant", () => {
    const parsed = externalActionApprovalSchema.safeParse({
      source: "human",
      actorId: "user-1",
      grantId: null,
      approvedAt: 1_700_000_000_000,
    });

    expect(parsed.success).toBe(true);
  });

  it("accepts an automation approval that names its grant", () => {
    const parsed = externalActionApprovalSchema.safeParse({
      source: "automation_grant",
      actorId: "executor-1",
      grantId: "grant-1",
      approvedAt: 1_700_000_000_000,
    });

    expect(parsed.success).toBe(true);
  });

  it("refuses a human approval that carries a grant", () => {
    const parsed = externalActionApprovalSchema.safeParse({
      source: "human",
      actorId: "user-1",
      grantId: "grant-1",
      approvedAt: 1_700_000_000_000,
    });

    expect(parsed.success).toBe(false);
  });

  it("refuses an automation approval without a grant", () => {
    const parsed = externalActionApprovalSchema.safeParse({
      source: "automation_grant",
      actorId: "executor-1",
      grantId: null,
      approvedAt: 1_700_000_000_000,
    });

    expect(parsed.success).toBe(false);
  });
});
