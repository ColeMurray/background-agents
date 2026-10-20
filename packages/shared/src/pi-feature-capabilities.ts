import { z } from "zod";

/** Ordered from least to most authority. Unknown configuration resolves to off. */
export const FEATURE_CAPABILITY_MODES = ["off", "read_only", "enabled"] as const;

export type FeatureCapabilityMode = (typeof FEATURE_CAPABILITY_MODES)[number];

/** Canonical independently gated features in the first-class Pi runtime. */
export const PI_FEATURE_IDS = [
  "workspace",
  "repositoryEditing",
  "codeMode",
  "sandboxExecution",
  "externalActions",
  "mcp",
  "crossSessionMessaging",
] as const;

export type PiFeatureId = (typeof PI_FEATURE_IDS)[number];

/** A complete gate snapshot; consumers must not rely on omitted-feature defaults. */
export type FeatureCapabilityMatrix<Feature extends string> = Readonly<
  Record<Feature, FeatureCapabilityMode>
>;

export type PiFeatureCapabilityMatrix = FeatureCapabilityMatrix<PiFeatureId>;

export type PiFeatureCapabilityInput = Partial<Readonly<Record<PiFeatureId, string | undefined>>>;

export const PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION = 2 as const;

/**
 * The snapshot version written before cross-session messaging existed.
 *
 * A stored version 1 snapshot is read as version 2 with the new feature off,
 * so an older session keeps working and the new capability stays closed.
 */
export const PI_FEATURE_CAPABILITY_SNAPSHOT_LEGACY_VERSION = 1 as const;

const featureCapabilityModeSchema = z.enum(FEATURE_CAPABILITY_MODES);

export const piFeatureCapabilityMatrixSchema = z
  .object({
    workspace: featureCapabilityModeSchema,
    repositoryEditing: featureCapabilityModeSchema,
    codeMode: featureCapabilityModeSchema,
    sandboxExecution: featureCapabilityModeSchema,
    externalActions: featureCapabilityModeSchema,
    mcp: featureCapabilityModeSchema,
    crossSessionMessaging: featureCapabilityModeSchema,
  })
  .strict();

/** A snapshot as it was written before cross-session messaging existed. */
const legacyPiFeatureCapabilityMatrixSchema = z
  .object({
    workspace: featureCapabilityModeSchema,
    repositoryEditing: featureCapabilityModeSchema,
    codeMode: featureCapabilityModeSchema,
    sandboxExecution: featureCapabilityModeSchema,
    externalActions: featureCapabilityModeSchema,
    mcp: featureCapabilityModeSchema,
  })
  .strict();

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
        version: z.literal(PI_FEATURE_CAPABILITY_SNAPSHOT_LEGACY_VERSION),
        capabilities: legacyPiFeatureCapabilityMatrixSchema,
      })
      .strict(),
  ])
  .transform((snapshot) =>
    snapshot.version === PI_FEATURE_CAPABILITY_SNAPSHOT_LEGACY_VERSION
      ? {
          version:
            PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION as typeof PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION,
          capabilities: {
            ...snapshot.capabilities,
            // A feature that did not exist cannot have been enabled.
            crossSessionMessaging: "off" as const,
          },
        }
      : snapshot
  );

export type PiFeatureCapabilitySnapshot = Readonly<{
  version: typeof PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION;
  capabilities: PiFeatureCapabilityMatrix;
}>;

/** Resolve all Pi feature gates once; omitted and unknown values fail closed. */
export function resolvePiFeatureCapabilities(
  input: PiFeatureCapabilityInput
): PiFeatureCapabilityMatrix {
  return {
    workspace: resolveFeatureCapability(input.workspace, { writableAlias: true }),
    repositoryEditing: resolveFeatureCapability(input.repositoryEditing),
    codeMode: resolveFeatureCapability(input.codeMode),
    sandboxExecution: resolveFeatureCapability(input.sandboxExecution),
    externalActions: resolveFeatureCapability(input.externalActions),
    mcp: resolveFeatureCapability(input.mcp),
    crossSessionMessaging: resolveFeatureCapability(input.crossSessionMessaging),
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

function resolveFeatureCapability(
  value: string | undefined,
  options: { readonly writableAlias?: boolean } = {}
): FeatureCapabilityMode {
  const normalized = value?.trim().toLowerCase();
  if (options.writableAlias && normalized === "writable") return "enabled";
  return normalized === "read_only" || normalized === "enabled" ? normalized : "off";
}
