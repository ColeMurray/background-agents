/**
 * Pure functions for resolving models and repos from configuration + labels.
 */

import type { TeamRepoMapping, StaticRepoConfig } from "./types";
import {
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidReasoningEffort,
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

const MODEL_LABEL_MAP: Record<string, string> = {
  haiku: "anthropic/claude-haiku-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",
  opus: "anthropic/claude-opus-4-5",
  "opus-4-6": "anthropic/claude-opus-4-6",
  "gpt-5.2": "openai/gpt-5.2",
  "gpt-5.2-codex": "openai/gpt-5.2-codex",
  "gpt-5.3-codex": "openai/gpt-5.3-codex",
};

/**
 * Extract model override from issue labels (e.g., "model:opus" → "anthropic/claude-opus-4-5").
 */
export function extractModelFromLabels(labels: Array<{ name: string }>): string | null {
  for (const label of labels) {
    const match = label.name.match(/^model:(.+)$/i);
    if (match) {
      const key = match[1].toLowerCase();
      if (MODEL_LABEL_MAP[key]) return MODEL_LABEL_MAP[key];
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
