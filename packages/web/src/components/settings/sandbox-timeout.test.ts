import { describe, expect, it } from "vitest";
import { sandboxTimeoutMinutesFromMs, sandboxTimeoutMsFromMinutes } from "./sandbox-timeout";

describe("sandbox timeout conversion", () => {
  it.each([
    ["0.5166666666666667", 31_000],
    ["2.05", 123_000],
    ["4.1", 246_000],
  ])("converts %s minutes to a whole-second timeout", (minutes, timeoutMs) => {
    expect(sandboxTimeoutMsFromMinutes(minutes)).toBe(timeoutMs);
  });

  it("rejects fractional-second durations", () => {
    expect(sandboxTimeoutMsFromMinutes("2.051")).toBeUndefined();
  });

  it("formats milliseconds as minutes", () => {
    expect(sandboxTimeoutMinutesFromMs(123_000)).toBe("2.05");
    expect(sandboxTimeoutMinutesFromMs(undefined)).toBe("");
  });
});
