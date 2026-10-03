import { describe, expect, it } from "vitest";
import { deriveInvocationStatus } from "./automation-store";

describe("deriveInvocationStatus", () => {
  it("keeps repository authorization denials distinct from successful runs", () => {
    expect(
      deriveInvocationStatus({
        total: 1,
        starting: 0,
        active: 0,
        failed: 0,
        completed: 0,
        skipped: 0,
        unauthorized: 1,
      })
    ).toBe("unauthorized");
  });

  it("keeps an invocation active until its running children finish", () => {
    expect(
      deriveInvocationStatus({
        total: 2,
        starting: 0,
        active: 1,
        failed: 0,
        completed: 0,
        skipped: 0,
        unauthorized: 1,
      })
    ).toBe("running");
  });
});
