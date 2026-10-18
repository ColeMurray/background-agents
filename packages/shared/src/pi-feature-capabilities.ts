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
] as const;

export type PiFeatureId = (typeof PI_FEATURE_IDS)[number];

/** A complete gate snapshot; consumers must not rely on omitted-feature defaults. */
export type FeatureCapabilityMatrix<Feature extends string> = Readonly<
  Record<Feature, FeatureCapabilityMode>
>;

export type PiFeatureCapabilityMatrix = FeatureCapabilityMatrix<PiFeatureId>;

export type PiFeatureCapabilityInput = Partial<Readonly<Record<PiFeatureId, string | undefined>>>;

export const PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION = 1 as const;

const featureCapabilityModeSchema = z.enum(FEATURE_CAPABILITY_MODES);

export const piFeatureCapabilitySnapshotSchema = z
  .object({
    version: z.literal(PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION),
    capabilities: z
      .object({
        workspace: featureCapabilityModeSchema,
        repositoryEditing: featureCapabilityModeSchema,
        codeMode: featureCapabilityModeSchema,
        sandboxExecution: featureCapabilityModeSchema,
        externalActions: featureCapabilityModeSchema,
        mcp: featureCapabilityModeSchema,
      })
      .strict(),
  })
  .strict();

export type PiFeatureCapabilitySnapshot = Readonly<{
  version: typeof PI_FEATURE_CAPABILITY_SNAPSHOT_VERSION;
  capabilities: PiFeatureCapabilityMatrix;
}>;

/** Resolve all Pi feature gates once; omitted and unknown values fail closed. */
export function resolvePiFeatureCapabilities(
  input: PiFeatureCapabilityInput
): PiFeatureCapabilityMatrix {
  return {
    workspace: resolveFeatureCapability(input.workspace),
    repositoryEditing: resolveFeatureCapability(input.repositoryEditing),
    codeMode: resolveFeatureCapability(input.codeMode),
    sandboxExecution: resolveFeatureCapability(input.sandboxExecution),
    externalActions: resolveFeatureCapability(input.externalActions),
    mcp: resolveFeatureCapability(input.mcp),
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

function resolveFeatureCapability(value: string | undefined): FeatureCapabilityMode {
  const normalized = value?.trim().toLowerCase();
  return normalized === "read_only" || normalized === "enabled" ? normalized : "off";
}
