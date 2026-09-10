import { describe, expect, it } from "vitest";
import { getPrerequisiteStatus } from "./prerequisite-status";

describe("getPrerequisiteStatus", () => {
  it("distinguishes pending, unavailable, and successful empty responses", () => {
    expect(getPrerequisiteStatus(undefined, true, undefined)).toBe("loading");
    expect(getPrerequisiteStatus(undefined, false, undefined)).toBe("unavailable");
    expect(getPrerequisiteStatus([], false, undefined)).toBe("ready");
  });

  it("does not treat errors or failed revalidation as authoritative data", () => {
    const error = new Error("Service unavailable");
    expect(getPrerequisiteStatus(undefined, false, error)).toBe("unavailable");
    expect(getPrerequisiteStatus([], false, error)).toBe("unavailable");
    expect(getPrerequisiteStatus([], true, error)).toBe("unavailable");
  });
});
