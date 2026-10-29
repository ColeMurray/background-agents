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
        retrying: 0,
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
        retrying: 0,
      })
    ).toBe("running");
  });

  it("reports a firing waiting to relaunch as retrying, behind any active run", () => {
    const waiting = {
      total: 2,
      starting: 0,
      active: 1,
      failed: 0,
      completed: 1,
      skipped: 0,
      unauthorized: 0,
      retrying: 1,
    };
    expect(deriveInvocationStatus(waiting)).toBe("retrying");
    expect(deriveInvocationStatus({ ...waiting, total: 3, active: 2 })).toBe("running");
  });
});
