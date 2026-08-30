import { describe, expect, it } from "vitest";
import { evaluateBudget, hasPositiveTokenUsage } from "./budget";

describe("evaluateBudget", () => {
  it("does nothing without a limit or below the warning threshold", () => {
    expect(
      evaluateBudget({
        totalCost: 100,
        maxCostUsd: null,
        warningThresholdPct: 80,
        warningSent: false,
        exhausted: false,
      })
    ).toBe("none");
    expect(
      evaluateBudget({
        totalCost: 7.99,
        maxCostUsd: 10,
        warningThresholdPct: 80,
        warningSent: false,
        exhausted: false,
      })
    ).toBe("none");
  });

  it("warns once at the configured threshold", () => {
    expect(
      evaluateBudget({
        totalCost: 8,
        maxCostUsd: 10,
        warningThresholdPct: 80,
        warningSent: false,
        exhausted: false,
      })
    ).toBe("warn");
    expect(
      evaluateBudget({
        totalCost: 9,
        maxCostUsd: 10,
        warningThresholdPct: 80,
        warningSent: true,
        exhausted: false,
      })
    ).toBe("none");
  });

  it("exhausts directly at the limit and does not repeat", () => {
    expect(
      evaluateBudget({
        totalCost: 12,
        maxCostUsd: 10,
        warningThresholdPct: 80,
        warningSent: false,
        exhausted: false,
      })
    ).toBe("exhaust");
    expect(
      evaluateBudget({
        totalCost: 13,
        maxCostUsd: 10,
        warningThresholdPct: 80,
        warningSent: false,
        exhausted: true,
      })
    ).toBe("none");
  });
});

describe("hasPositiveTokenUsage", () => {
  it.each([
    1,
    { total: 1 },
    { input: 1 },
    { output: 1 },
    { reasoning: 1 },
    { cache: { read: 1 } },
    { cache: { write: 1 } },
  ])("recognizes positive token usage %#", (tokens) => {
    expect(hasPositiveTokenUsage(tokens)).toBe(true);
  });

  it.each([undefined, 0, -1, {}, { input: 0 }, { cache: { read: 0, write: 0 } }])(
    "rejects non-positive token usage %#",
    (tokens) => {
      expect(hasPositiveTokenUsage(tokens)).toBe(false);
    }
  );
});
