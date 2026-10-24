import { z } from "zod";

/**
 * The capability gate: how much of a feature a deployment admits, and a
 * session holds.
 *
 * Three modes, ordered from least to most authority: `off`, `read_only` and
 * `enabled`. Unknown configuration resolves to `off`, so a typo or a missing
 * variable fails closed rather than open.
 *
 * This is the contract for any harness that gates a feature; it names no
 * feature, so it belongs to no one harness.
 */
export const FEATURE_CAPABILITY_MODES = ["off", "read_only", "enabled"] as const;

export type FeatureCapabilityMode = (typeof FEATURE_CAPABILITY_MODES)[number];

/** A complete gate snapshot; consumers must not rely on omitted-feature defaults. */
export type FeatureCapabilityMatrix<Feature extends string> = Readonly<
  Record<Feature, FeatureCapabilityMode>
>;

export type FeatureCapabilityInput = Partial<Readonly<Record<string, string | undefined>>>;

export const featureCapabilityModeSchema = z.enum(FEATURE_CAPABILITY_MODES);

/**
 * Resolve one gate.
 *
 * A value that is not exactly one of the two admitting modes is `off`.
 */
export function resolveFeatureCapability(
  value: string | undefined,
  options: { readonly writableAlias?: boolean } = {}
): FeatureCapabilityMode {
  const normalized = value?.trim().toLowerCase();
  if (options.writableAlias && normalized === "writable") return "enabled";
  return normalized === "read_only" || normalized === "enabled" ? normalized : "off";
}
