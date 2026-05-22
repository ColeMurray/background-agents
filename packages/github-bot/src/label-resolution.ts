/**
 * Label-based config overrides for GitHub issues / pull requests.
 *
 * Uses the same flat dash-separated convention as Linear (Linear forbids `:`
 * in labels, so dash unifies both platforms):
 *   - `plan`                       → opt the @mention-triggered session into plan mode
 *   - `plan-<alias>`               → trigger plan-mode AND override plan-turn model
 *   - `model-<alias>`              → override build-turn model
 *   - `build-<alias>`              → build model override (alias of `model-<alias>`)
 *   - `review-<alias>`             → override model used when auto-reviewing a PR
 *
 * Omit the label to use the env default — there is no `<prefix>-default` alias.
 *
 * The `<alias>` → canonical model id map (MODEL_ALIAS_MAP) lives in
 * @open-inspect/shared so it stays in sync with the Linear parser.
 */

import { MODEL_ALIAS_MAP } from "@open-inspect/shared";

export interface GitHubLabel {
  name: string;
}

// `model` and `build` are interchangeable for the impl-model override.
const PREFIXES_IMPL_MODEL = ["build", "model"] as const;

export function hasPlanLabel(labels: GitHubLabel[]): boolean {
  if (labels.some((l) => l.name.trim().toLowerCase() === "plan")) return true;
  return labels.some((l) => /^plan-.+$/i.test(l.name.trim()));
}

export function extractModelFromLabels(labels: GitHubLabel[]): string | null {
  for (const prefix of PREFIXES_IMPL_MODEL) {
    const resolved = extractByPrefix(labels, prefix);
    if (resolved) return resolved;
  }
  return null;
}

export function extractPlanModelFromLabels(labels: GitHubLabel[]): string | null {
  return extractByPrefix(labels, "plan");
}

export function extractReviewModelFromLabels(labels: GitHubLabel[]): string | null {
  return extractByPrefix(labels, "review");
}

function extractByPrefix(labels: GitHubLabel[], prefix: string): string | null {
  const re = new RegExp(`^${prefix}-(.+)$`, "i");
  for (const label of labels) {
    const match = label.name.trim().match(re);
    if (!match) continue;
    const alias = match[1].toLowerCase();
    if (MODEL_ALIAS_MAP[alias]) return MODEL_ALIAS_MAP[alias];
  }
  return null;
}
