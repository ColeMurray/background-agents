import { z } from "zod";
import {
  featureCapabilityModeSchema,
  resolveFeatureCapability,
  type FeatureCapabilityInput,
  type FeatureCapabilityMatrix,
} from "./capability-modes";

/** Ordered from least to most authority. Unknown configuration resolves to off. */

/**
 * Canonical independently gated features in the first-class Pi runtime.
 *
 * The scratch workspace is the session's own Computer VFS. It is not the
 * Open-Inspect workspace, which is the tenant, and it is not the native
 * execution sandbox's `/workspace`, which is a third filesystem. The three
 * are named distinctly so an API or a screen never makes them look alike.
 */
export const PI_FEATURE_IDS = [
  "scratchWorkspace",
  "repositoryEditing",
  "codeMode",
  "sandboxExecution",
  "mcp",
  "browser",
  "memory",
] as const;

export type PiFeatureId = (typeof PI_FEATURE_IDS)[number];

export type PiFeatureCapabilityMatrix = FeatureCapabilityMatrix<PiFeatureId>;

export type PiFeatureCapabilityInput = FeatureCapabilityInput;

export const PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION = 6 as const;

/**
 * The snapshot version written before the MCP capability existed.
 *
 * It carried every feature except the MCP lane. It is read as the current
 * version with the MCP lane closed, so a session created before the shared
 * MCP lane existed keeps working and the new capability stays closed.
 */
export const PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MCP_VERSION = 5 as const;

/**
 * The snapshot version written before the memory capability existed.
 *
 * It carried every feature except the memory. It is read as the current
 * version with the memory closed, so a session created before the memory
 * tools existed keeps working and the new capability stays closed.
 */
export const PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MEMORY_VERSION = 4 as const;

/**
 * The snapshot version written before the browser capability existed.
 *
 * It carried every feature except the browser. It is read as the current
 * version with the browser closed.
 */
export const PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_BROWSER_VERSION = 3 as const;

/**
 * The snapshot version written before the scratch workspace was renamed.
 *
 * It carried a feature called `workspace`, which collided with the
 * Open-Inspect workspace. It is read as the current version with the same
 * mode under the new name, so a rename never changes what a session may do.
 */
export const PI_FEATURE_CAPABILITY_SNAPSHOT_RENAMED_VERSION = 2 as const;

/**
 * The earliest snapshot version.
 *
 * It carried the capabilities the core no longer has. A stored version 1
 * snapshot is read as the current version with the capabilities that did not
 * exist then closed, so an older session keeps working and the newer
 * capabilities stay closed.
 */
export const PI_FEATURE_CAPABILITY_SNAPSHOT_LEGACY_VERSION = 1 as const;

export const piFeatureCapabilityMatrixSchema = z
  .object({
    scratchWorkspace: featureCapabilityModeSchema,
    repositoryEditing: featureCapabilityModeSchema,
    codeMode: featureCapabilityModeSchema,
    sandboxExecution: featureCapabilityModeSchema,
    mcp: featureCapabilityModeSchema,
    browser: featureCapabilityModeSchema,
    memory: featureCapabilityModeSchema,
  })
  .strict();

/**
 * A snapshot as it was written before the MCP capability existed.
 *
 * The reader is deliberately not strict: a snapshot this version wrote may
 * also carry a capability the core no longer has, and a strict reader would
 * reject the whole snapshot instead of closing the capability it no longer
 * knows. The unknown key is dropped, and the transform closes the capability.
 */
const preMcpPiFeatureCapabilityMatrixSchema = z.object({
  scratchWorkspace: featureCapabilityModeSchema,
  repositoryEditing: featureCapabilityModeSchema,
  codeMode: featureCapabilityModeSchema,
  sandboxExecution: featureCapabilityModeSchema,
  browser: featureCapabilityModeSchema,
  memory: featureCapabilityModeSchema,
});

/**
 * A snapshot as it was written before the memory capability existed.
 *
 * Not strict, for the same reason as every other legacy reader.
 */
const preMemoryPiFeatureCapabilityMatrixSchema = z.object({
  scratchWorkspace: featureCapabilityModeSchema,
  repositoryEditing: featureCapabilityModeSchema,
  codeMode: featureCapabilityModeSchema,
  sandboxExecution: featureCapabilityModeSchema,
  browser: featureCapabilityModeSchema,
});

/**
 * A snapshot as it was written before the browser capability existed.
 *
 * Not strict, for the same reason as every other legacy reader.
 */
const preBrowserPiFeatureCapabilityMatrixSchema = z.object({
  scratchWorkspace: featureCapabilityModeSchema,
  repositoryEditing: featureCapabilityModeSchema,
  codeMode: featureCapabilityModeSchema,
  sandboxExecution: featureCapabilityModeSchema,
});

/**
 * A snapshot as it was written before the scratch workspace was renamed.
 *
 * Not strict, for the same reason as every other legacy reader.
 */
const renamedPiFeatureCapabilityMatrixSchema = z.object({
  workspace: featureCapabilityModeSchema,
  repositoryEditing: featureCapabilityModeSchema,
  codeMode: featureCapabilityModeSchema,
  sandboxExecution: featureCapabilityModeSchema,
});

/**
 * A snapshot as it was written before the scratch workspace was renamed.
 *
 * The earliest version carried the capabilities the renamed version carried,
 * so both are read the same way.
 */
const legacyPiFeatureCapabilityMatrixSchema = renamedPiFeatureCapabilityMatrixSchema;

export const piFeatureCapabilitySnapshotSchema = z
  .union([
    z
      .object({
        version: z.literal(PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION),
        capabilities: piFeatureCapabilityMatrixSchema,
      })
      .strict(),
    z
      .object({
        version: z.literal(PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MCP_VERSION),
        capabilities: preMcpPiFeatureCapabilityMatrixSchema,
      })
      .strict(),
    z
      .object({
        version: z.literal(PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MEMORY_VERSION),
        capabilities: preMemoryPiFeatureCapabilityMatrixSchema,
      })
      .strict(),
    z
      .object({
        version: z.literal(PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_BROWSER_VERSION),
        capabilities: preBrowserPiFeatureCapabilityMatrixSchema,
      })
      .strict(),
    z
      .object({
        version: z.literal(PI_FEATURE_CAPABILITY_SNAPSHOT_RENAMED_VERSION),
        capabilities: renamedPiFeatureCapabilityMatrixSchema,
      })
      .strict(),
    z
      .object({
        version: z.literal(PI_FEATURE_CAPABILITY_SNAPSHOT_LEGACY_VERSION),
        capabilities: legacyPiFeatureCapabilityMatrixSchema,
      })
      .strict(),
  ])
  .transform((snapshot): PiFeatureCapabilitySnapshot => {
    if (snapshot.version === PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION) {
      return {
        version: PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION,
        capabilities: snapshot.capabilities,
      };
    }
    if (snapshot.version === PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MCP_VERSION) {
      return {
        version: PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION,
        capabilities: {
          ...snapshot.capabilities,
          // A feature that did not exist cannot have been enabled.
          mcp: "off",
        },
      };
    }
    if (snapshot.version === PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_MEMORY_VERSION) {
      return {
        version: PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION,
        capabilities: {
          ...snapshot.capabilities,
          // A feature that did not exist cannot have been enabled.
          mcp: "off",
          memory: "off",
        },
      };
    }
    if (snapshot.version === PI_FEATURE_CAPABILITY_SNAPSHOT_PRE_BROWSER_VERSION) {
      return {
        version: PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION,
        capabilities: {
          ...snapshot.capabilities,
          // A feature that did not exist cannot have been enabled.
          mcp: "off",
          browser: "off",
          memory: "off",
        },
      };
    }
    const { workspace, ...rest } = snapshot.capabilities;
    return {
      version: PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION,
      capabilities: {
        // A rename never changes what a session may do.
        scratchWorkspace: workspace,
        repositoryEditing: rest.repositoryEditing,
        codeMode: rest.codeMode,
        sandboxExecution: rest.sandboxExecution,
        // A feature that did not exist cannot have been enabled.
        mcp: "off",
        browser: "off",
        memory: "off",
      },
    };
  });

export type PiFeatureCapabilitySnapshot = Readonly<{
  version: typeof PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION;
  capabilities: PiFeatureCapabilityMatrix;
}>;

/** Resolve all Pi feature gates once; omitted and unknown values fail closed. */
export function resolvePiFeatureCapabilities(
  input: PiFeatureCapabilityInput
): PiFeatureCapabilityMatrix {
  return {
    scratchWorkspace: resolveFeatureCapability(input.scratchWorkspace, { writableAlias: true }),
    repositoryEditing: resolveFeatureCapability(input.repositoryEditing),
    codeMode: resolveFeatureCapability(input.codeMode),
    sandboxExecution: resolveFeatureCapability(input.sandboxExecution),
    mcp: resolveFeatureCapability(input.mcp),
    browser: resolveFeatureCapability(input.browser),
    memory: resolveFeatureCapability(input.memory),
  };
}

/** Build the immutable value latched into one Pi session before extension assembly. */
export function createPiFeatureCapabilitySnapshot(
  input: PiFeatureCapabilityInput
): PiFeatureCapabilitySnapshot {
  return {
    version: PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION,
    capabilities: resolvePiFeatureCapabilities(input),
  };
}
