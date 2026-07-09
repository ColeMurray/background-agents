/**
 * Pure functions for resolving models and repos from configuration + labels.
 */

import type { TeamRepoMapping, StaticTargetConfig } from "./types";
import {
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidReasoningEffort,
} from "@open-inspect/shared";

/**
 * Resolve a target (repository or environment) from the static team mapping:
 * the first entry whose label matches an issue label, else the first
 * label-less entry.
 */
export function resolveStaticTarget(
  teamMapping: TeamRepoMapping,
  teamId: string,
  issueLabels?: string[]
): StaticTargetConfig | null {
  const targetConfigs = teamMapping[teamId];
  if (!targetConfigs || targetConfigs.length === 0) return null;

  const labelSet = new Set((issueLabels || []).map((l) => l.toLowerCase()));
  return (
    targetConfigs.find((t) => t.label && labelSet.has(t.label.toLowerCase())) ||
    targetConfigs.find((t) => !t.label) ||
    null
  );
}

const MODEL_LABEL_MAP: Record<string, string> = {
  haiku: "anthropic/claude-haiku-4-5",
  sonnet: "anthropic/claude-sonnet-4-5",
  opus: "anthropic/claude-opus-4-5",
  "opus-4-6": "anthropic/claude-opus-4-6",
  "opus-4-7": "anthropic/claude-opus-4-7",
  "opus-4-8": "anthropic/claude-opus-4-8",
  fable: "anthropic/claude-fable-5",
  "fable-5": "anthropic/claude-fable-5",
  "gpt-5.2": "openai/gpt-5.2",
  "gpt-5.4": "openai/gpt-5.4",
  "gpt-5.5": "openai/gpt-5.5",
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
