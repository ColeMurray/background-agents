import { describe, expect, it } from "vitest";
import { formatSessionCost } from "./session-cost";

describe("formatSessionCost", () => {
  it("formats sub-dollar costs with four decimals", () => {
    expect(formatSessionCost(0.0168)).toBe("$0.0168");
  });

  it("formats dollar costs with two decimals", () => {
    expect(formatSessionCost(1.5)).toBe("$1.50");
  });

  it("formats tiny costs with precision instead of rounding to zero", () => {
    expect(formatSessionCost(0.00001)).toBe("$0.000010");
  });
});
