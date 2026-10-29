import { describe, expect, it } from "vitest";
import { sameEnvironmentIds } from "./automation-target-selection";

describe("sameEnvironmentIds", () => {
  it("compares stored environment links without changing their order", () => {
    const saved = ["env_2", "env_1"];
    const selected = ["env_1", "env_2"];
    expect(sameEnvironmentIds(selected, saved)).toBe(true);
    expect(saved).toEqual(["env_2", "env_1"]);
    expect(selected).toEqual(["env_1", "env_2"]);
  });

  it("recognizes additions, removals, clearing and empty selections", () => {
    expect(sameEnvironmentIds(["env_1", "env_2"], ["env_1"])).toBe(false);
    expect(sameEnvironmentIds(["env_1"], ["env_1", "env_2"])).toBe(false);
    expect(sameEnvironmentIds([], ["env_1"])).toBe(false);
    expect(sameEnvironmentIds([], [])).toBe(true);
  });
});
