import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FEATURE_CAPABILITY_MODES,
  PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION,
  PI_FEATURE_IDS,
  createPiFeatureCapabilitySnapshot,
  piFeatureCapabilitySnapshotSchema,
  resolvePiFeatureCapabilities,
  type PiFeatureCapabilityMatrix,
} from "./pi-feature-capabilities";

describe("Pi feature capability contracts", () => {
  it("uses one fail-closed capability vocabulary for every feature gate", () => {
    expect(FEATURE_CAPABILITY_MODES).toEqual(["off", "read_only", "enabled"]);
    expect(PI_FEATURE_IDS).toEqual([
      "workspace",
      "repositoryEditing",
      "codeMode",
      "sandboxExecution",
      "externalActions",
      "mcp",
    ]);
  });

  it("requires every feature to have an explicit capability", () => {
    const matrix = {
      workspace: "read_only",
      repositoryEditing: "off",
      codeMode: "off",
      sandboxExecution: "off",
      externalActions: "off",
      mcp: "off",
    } as const satisfies PiFeatureCapabilityMatrix;

    expectTypeOf(matrix).toMatchTypeOf<PiFeatureCapabilityMatrix>();
    expect(Object.keys(matrix)).toEqual(PI_FEATURE_IDS);
  });

  it("resolves one complete snapshot and fails unknown values closed", () => {
    expect(
      resolvePiFeatureCapabilities({
        workspace: " READ_ONLY ",
        repositoryEditing: "enabled",
        codeMode: "enabled",
        sandboxExecution: "unexpected",
      })
    ).toEqual({
      workspace: "read_only",
      repositoryEditing: "enabled",
      codeMode: "enabled",
      sandboxExecution: "off",
      externalActions: "off",
      mcp: "off",
    });
  });

  it("creates one validated versioned snapshot for durable per-session latching", () => {
    const snapshot = createPiFeatureCapabilitySnapshot({ workspace: "read_only" });

    expect(PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION).toBe(1);
    expect(snapshot).toEqual({
      version: 1,
      capabilities: {
        workspace: "read_only",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
      },
    });
    expect(piFeatureCapabilitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });
});
