import { describe, expect, it } from "vitest";
import { hasPositiveTokenUsage } from "./budget";

describe("hasPositiveTokenUsage", () => {
  it.each([
    { total: 1 },
    { input: 1 },
    { output: 1 },
    { reasoning: 1 },
    { cache: { read: 1 } },
    { cache: { write: 1 } },
  ])("recognizes positive token usage %#", (tokens) => {
    expect(hasPositiveTokenUsage(tokens)).toBe(true);
  });

  it.each([undefined, 1, 0, -1, {}, { input: 0 }, { cache: { read: 0, write: 0 } }])(
    "rejects non-positive token usage %#",
    (tokens) => {
      expect(hasPositiveTokenUsage(tokens)).toBe(false);
    }
  );
});
