/** Ordered from least to most authority. Unknown configuration must resolve to off. */
export const FEATURE_CAPABILITY_MODES = ["off", "read_only", "enabled"] as const;

export type FeatureCapabilityMode = (typeof FEATURE_CAPABILITY_MODES)[number];

/** Independently gated features in the first-class Pi runtime. */
export const PI_FEATURE_IDS = [
  "workspace",
  "code_mode",
  "sandbox_execution",
  "external_actions",
  "mcp",
] as const;

export type PiFeatureId = (typeof PI_FEATURE_IDS)[number];

/** A complete gate snapshot; consumers must not rely on omitted-feature defaults. */
export type FeatureCapabilityMatrix<Feature extends string> = Readonly<
  Record<Feature, FeatureCapabilityMode>
>;

export type PiFeatureCapabilityMatrix = FeatureCapabilityMatrix<PiFeatureId>;
