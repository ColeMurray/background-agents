import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FEATURE_CAPABILITY_MODES,
  PI_FEATURE_IDS,
  type PiFeatureCapabilityMatrix,
} from "./pi-feature-capabilities";

describe("Pi feature capability contracts", () => {
  it("uses one fail-closed capability vocabulary for every feature gate", () => {
    expect(FEATURE_CAPABILITY_MODES).toEqual(["off", "read_only", "enabled"]);
    expect(PI_FEATURE_IDS).toEqual([
      "workspace",
      "code_mode",
      "sandbox_execution",
      "external_actions",
      "mcp",
    ]);
  });

  it("requires every feature to have an explicit capability", () => {
    const matrix = {
      workspace: "read_only",
      code_mode: "off",
      sandbox_execution: "off",
      external_actions: "off",
      mcp: "off",
    } as const satisfies PiFeatureCapabilityMatrix;

    expectTypeOf(matrix).toMatchTypeOf<PiFeatureCapabilityMatrix>();
    expect(Object.keys(matrix)).toEqual(PI_FEATURE_IDS);
  });
});
