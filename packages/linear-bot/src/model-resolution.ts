/**
 * Pure functions for resolving models and repos from configuration + labels.
 */

import type { TeamRepoMapping, StaticRepoConfig } from "./types";
import {
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
  isValidReasoningEffort,
  resolveModelAlias,
} from "@open-inspect/shared";

/**
 * Resolve repo from static team mapping (legacy/override).
 */
export function resolveStaticRepo(
  teamMapping: TeamRepoMapping,
  teamId: string,
  issueLabels?: string[]
): StaticRepoConfig | null {
  const repoConfigs = teamMapping[teamId];
  if (!repoConfigs || repoConfigs.length === 0) return null;

  const labelSet = new Set((issueLabels || []).map((l) => l.toLowerCase()));
  return (
    repoConfigs.find((r) => r.label && labelSet.has(r.label.toLowerCase())) ||
    repoConfigs.find((r) => !r.label) ||
    null
  );
}

/**
 * Extract model override from issue labels (e.g., "model:opus" → canonical id).
 *
 * Alias resolution is delegated to the shared `resolveModelAlias` helper so
 * Linear, GitHub, and any future bot stay in lockstep with the canonical
 * model list. Returns null when the label doesn't resolve to a valid model.
 */
export function extractModelFromLabels(labels: Array<{ name: string }>): string | null {
  for (const label of labels) {
    const match = label.name.match(/^model:(.+)$/i);
    if (match) {
      const resolved = resolveModelAlias(match[1].toLowerCase());
      if (isValidModel(resolved)) return resolved;
    }
  }
  return null;
}

export interface ResolveSessionModelInput {
  envDefaultModel: string;
  configModel: string | null;
  configReasoningEffort: string | null;
  allowUserPreferenceOverride: boolean;
  allowLabelModelOverride: boolean;
  userModel?: string;
  userReasoningEffort?: string;
  labelModel?: string | null;
}

export function resolveSessionModelSettings(input: ResolveSessionModelInput): {
  model: string;
  reasoningEffort: string | undefined;
} {
  let model = input.configModel ?? input.envDefaultModel;
  let modelSource: "config" | "env" | "user" | "label" = input.configModel ? "config" : "env";

  if (input.allowUserPreferenceOverride && input.userModel) {
    model = input.userModel;
    modelSource = "user";
  }

  if (input.allowLabelModelOverride && input.labelModel) {
    model = input.labelModel;
    modelSource = "label";
  }

  const normalizedModel = getValidModelOrDefault(model);

  if (
    input.allowUserPreferenceOverride &&
    input.userReasoningEffort &&
    isValidReasoningEffort(normalizedModel, input.userReasoningEffort)
  ) {
    return { model: normalizedModel, reasoningEffort: input.userReasoningEffort };
  }

  if (
    modelSource !== "user" &&
    modelSource !== "label" &&
    input.configReasoningEffort &&
    isValidReasoningEffort(normalizedModel, input.configReasoningEffort)
  ) {
    return { model: normalizedModel, reasoningEffort: input.configReasoningEffort };
  }

  return { model: normalizedModel, reasoningEffort: getDefaultReasoningEffort(normalizedModel) };
}
