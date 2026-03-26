import { describe, expect, it } from "vitest";
import { formatSessionCost, getTotalSessionCost } from "./session-cost";

describe("getTotalSessionCost", () => {
  it("sums step-finish costs and ignores unrelated events", () => {
    const total = getTotalSessionCost([
      {
        type: "token",
        content: "hello",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 1,
      },
      {
        type: "step_finish",
        messageId: "msg-1",
        sandboxId: "sb-1",
        timestamp: 2,
        cost: 0.0123,
      },
      {
        type: "step_finish",
        messageId: "msg-2",
        sandboxId: "sb-1",
        timestamp: 3,
        cost: 0.0045,
      },
      {
        type: "step_finish",
        messageId: "msg-3",
        sandboxId: "sb-1",
        timestamp: 4,
      },
    ]);

    expect(total).toBeCloseTo(0.0168);
  });
});

describe("formatSessionCost", () => {
  it("formats sub-dollar costs with four decimals", () => {
    expect(formatSessionCost(0.0168)).toBe("$0.0168");
  });

  it("formats dollar costs with two decimals", () => {
    expect(formatSessionCost(1.5)).toBe("$1.50");
  });
});
