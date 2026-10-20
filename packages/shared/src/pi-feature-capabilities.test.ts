import { describe, expect, expectTypeOf, it } from "vitest";
import {
  FEATURE_CAPABILITY_MODES,
  PI_FEATURE_CAPABILITY_SNAPSHOT_LEGACY_VERSION,
  PI_FEATURE_CAPABILITY_SNAPSHOT_RENAMED_VERSION,
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
      "scratchWorkspace",
      "repositoryEditing",
      "codeMode",
      "sandboxExecution",
      "externalActions",
      "mcp",
      "crossSessionMessaging",
    ]);
  });

  it("requires every feature to have an explicit capability", () => {
    const matrix = {
      scratchWorkspace: "read_only",
      repositoryEditing: "off",
      codeMode: "off",
      sandboxExecution: "off",
      externalActions: "off",
      mcp: "off",
      crossSessionMessaging: "off",
    } as const satisfies PiFeatureCapabilityMatrix;

    expectTypeOf(matrix).toMatchTypeOf<PiFeatureCapabilityMatrix>();
    expect(Object.keys(matrix)).toEqual(PI_FEATURE_IDS);
  });

  it("resolves one complete snapshot and fails unknown values closed", () => {
    expect(
      resolvePiFeatureCapabilities({
        scratchWorkspace: " READ_ONLY ",
        repositoryEditing: "enabled",
        codeMode: "enabled",
        sandboxExecution: "unexpected",
      })
    ).toEqual({
      scratchWorkspace: "read_only",
      repositoryEditing: "enabled",
      codeMode: "enabled",
      sandboxExecution: "off",
      externalActions: "off",
      mcp: "off",
      crossSessionMessaging: "off",
    });
  });

  it("normalizes the deployment scratch writable alias exactly once", () => {
    expect(resolvePiFeatureCapabilities({ scratchWorkspace: " WrItAbLe " }).scratchWorkspace).toBe(
      "enabled"
    );
    expect(resolvePiFeatureCapabilities({ repositoryEditing: "writable" }).repositoryEditing).toBe(
      "off"
    );
  });

  it("creates one validated versioned snapshot for durable per-session latching", () => {
    const snapshot = createPiFeatureCapabilitySnapshot({ scratchWorkspace: "read_only" });

    expect(PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION).toBe(3);
    expect(snapshot).toEqual({
      version: 3,
      capabilities: {
        scratchWorkspace: "read_only",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
        crossSessionMessaging: "off",
      },
    });
    expect(piFeatureCapabilitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("reads a snapshot written before cross-session messaging with the new feature closed", () => {
    const legacy = {
      version: PI_FEATURE_CAPABILITY_SNAPSHOT_LEGACY_VERSION,
      capabilities: {
        workspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
      },
    };

    expect(piFeatureCapabilitySnapshotSchema.parse(legacy)).toEqual({
      version: 3,
      capabilities: {
        // The rename never changes what a session may do.
        scratchWorkspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
        // A feature that did not exist cannot have been enabled.
        crossSessionMessaging: "off",
      },
    });
  });

  it("reads a snapshot written before the scratch workspace was renamed", () => {
    const renamed = {
      version: PI_FEATURE_CAPABILITY_SNAPSHOT_RENAMED_VERSION,
      capabilities: {
        workspace: "enabled",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
        crossSessionMessaging: "enabled",
      },
    };

    expect(piFeatureCapabilitySnapshotSchema.parse(renamed)).toEqual({
      version: 3,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        externalActions: "off",
        mcp: "off",
        crossSessionMessaging: "enabled",
      },
    });
  });
});
