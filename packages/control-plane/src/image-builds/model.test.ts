import { describe, expect, it } from "vitest";
import { runtimeGenerationAtLeast } from "./model";

describe("runtimeGenerationAtLeast", () => {
  it.each([
    ["v78-current", 78, true],
    ["v79-newer", 78, true],
    ["v77-older", 78, false],
    ["unversioned", 1, false],
    ["", 1, false],
    [null, 1, false],
    [undefined, 1, false],
  ])("treats %j against floor %i as %s", (version, floor, expected) => {
    expect(runtimeGenerationAtLeast(version, floor)).toBe(expected);
  });
});
