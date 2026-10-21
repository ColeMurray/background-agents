import { describe, expect, it } from "vitest";
import {
  projectionAdmissionDeadline,
  projectionDeliveryDeadline,
  projectionRetryOutcome,
  PermanentPiResultDeliveryError,
  RetryablePiProjectionError,
  shouldAwaitProjectionAdmission,
} from "./projection-retry-policy";

describe("projectionRetryOutcome", () => {
  it("reschedules only explicitly retryable failures after bounded attempts", () => {
    expect(
      projectionRetryOutcome(new RetryablePiProjectionError("temporary"), 2_000, () => 1_000)
    ).toEqual({ rescheduleAt: 6_000 });
  });

  it("completes permanently invalid jobs after bounded attempts", () => {
    expect(
      projectionRetryOutcome(new Error("invalid payload"), 2_000, () => 1_000)
    ).toBeUndefined();
    expect(
      projectionRetryOutcome(new RetryablePiProjectionError("expired"), 1_000, () => 1_000)
    ).toBeUndefined();
    expect(
      projectionRetryOutcome(
        new PermanentPiResultDeliveryError("result rejected (409)"),
        2_000,
        () => 1_000
      )
    ).toBeUndefined();
  });

  it("waits for a scheduled operation to become durably admitted", () => {
    const deadline = projectionAdmissionDeadline(() => 1_000);
    expect(
      shouldAwaitProjectionAdmission(
        { status: "unanswered", reason: "not_found" },
        deadline,
        () => deadline - 1
      )
    ).toBe(true);
    expect(
      shouldAwaitProjectionAdmission(
        { status: "unanswered", reason: "not_found" },
        deadline,
        () => deadline
      )
    ).toBe(false);
  });

  it("bounds durable delivery retries", () => {
    expect(projectionDeliveryDeadline(() => 1_000)).toBe(86_401_000);
  });
});
