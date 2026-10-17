import { describe, expect, it } from "vitest";
import { projectionRetryOutcome, RetryablePiProjectionError } from "./projection-retry-policy";

describe("projectionRetryOutcome", () => {
  it("reschedules only explicitly retryable failures after bounded attempts", () => {
    expect(
      projectionRetryOutcome(new RetryablePiProjectionError("temporary"), () => 1_000)
    ).toEqual({ rescheduleAt: 6_000 });
  });

  it("completes permanently invalid jobs after bounded attempts", () => {
    expect(projectionRetryOutcome(new Error("invalid payload"), () => 1_000)).toBeUndefined();
  });
});
