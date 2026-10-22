import { describe, expect, expectTypeOf, it } from "vitest";
import {
  PI_FEATURE_CAPABILITY_SNAPSHOT_LEGACY_VERSION,
  PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_BROWSER_VERSION,
  PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MEMORY_VERSION,
  PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MCP_VERSION,
  PI_FEATURE_CAPABILITY_SNAPSHOT_RENAMED_VERSION,
  PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION,
  PI_FEATURE_IDS,
  createPiFeatureCapabilitySnapshot,
  piFeatureCapabilitySnapshotSchema,
  resolvePiFeatureCapabilities,
  type PiFeatureCapabilityMatrix,
} from "./pi-runtime-feature-capabilities";
import { FEATURE_CAPABILITY_MODES } from "./capability-modes";

describe("Pi feature capability contracts", () => {
  it("uses one fail-closed capability vocabulary for every feature gate", () => {
    expect(FEATURE_CAPABILITY_MODES).toEqual(["off", "read_only", "enabled"]);
    expect(PI_FEATURE_IDS).toEqual([
      "scratchWorkspace",
      "repositoryEditing",
      "codeMode",
      "sandboxExecution",
      "mcp",
      "browser",
      "memory",
    ]);
  });

  it("requires every feature to have an explicit capability", () => {
    const matrix = {
      scratchWorkspace: "read_only",
      repositoryEditing: "off",
      codeMode: "off",
      sandboxExecution: "off",
      mcp: "off",
      browser: "off",
      memory: "off",
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
      mcp: "off",
      browser: "off",
      memory: "off",
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

    expect(PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION).toBe(6);
    expect(snapshot).toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "read_only",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
    expect(piFeatureCapabilitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
  });

  it("reads a snapshot written before the MCP capability with the new feature closed", () => {
    const preMcp = {
      version: PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MCP_VERSION,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "off",
        browser: "off",
        memory: "off",
      },
    };

    expect(piFeatureCapabilitySnapshotSchema.parse(preMcp)).toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "off",
        // A feature that did not exist cannot have been enabled.
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
  });

  it("reads a snapshot written before the memory capability with the new feature closed", () => {
    const preMemory = {
      version: PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MEMORY_VERSION,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "off",
        browser: "off",
      },
    };

    expect(piFeatureCapabilitySnapshotSchema.parse(preMemory)).toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "off",
        // A feature that did not exist cannot have been enabled.
        mcp: "off",
        browser: "off",
        // A feature that did not exist cannot have been enabled.
        memory: "off",
      },
    });
  });

  it("reads the earliest snapshot with the renamed workspace and the newer capabilities closed", () => {
    const legacy = {
      version: PI_FEATURE_CAPABILITY_SNAPSHOT_LEGACY_VERSION,
      capabilities: {
        workspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "off",
      },
    };

    expect(piFeatureCapabilitySnapshotSchema.parse(legacy)).toEqual({
      version: 6,
      capabilities: {
        // The rename never changes what a session may do.
        scratchWorkspace: "enabled",
        repositoryEditing: "enabled",
        codeMode: "off",
        sandboxExecution: "off",
        // A feature that did not exist cannot have been enabled.
        mcp: "off",
        browser: "off",
        memory: "off",
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
      },
    };

    expect(piFeatureCapabilitySnapshotSchema.parse(renamed)).toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        // A feature that did not exist cannot have been enabled.
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
  });

  it("reads a snapshot written before the browser capability with the new feature closed", () => {
    const preBrowser = {
      version: PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_BROWSER_VERSION,
      capabilities: {
        scratchWorkspace: "off",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
      },
    };

    expect(piFeatureCapabilitySnapshotSchema.parse(preBrowser)).toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "off",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        // A feature that did not exist cannot have been enabled.
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
  });

  it("reads a stored snapshot that still carries a capability the core no longer has", () => {
    const stored = {
      version: PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MCP_VERSION,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        // The capabilities the core no longer has. A stored snapshot that
        // still names them is read, not rejected, and they are closed.
        externalActions: "enabled",
        crossSessionMessaging: "enabled",
        browser: "off",
        memory: "off",
      },
    };

    expect(piFeatureCapabilitySnapshotSchema.parse(stored)).toEqual({
      version: 6,
      capabilities: {
        scratchWorkspace: "enabled",
        repositoryEditing: "off",
        codeMode: "off",
        sandboxExecution: "off",
        // A feature that did not exist cannot have been enabled.
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    });
  });
});
