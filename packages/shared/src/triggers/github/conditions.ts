/** GitHub-specific condition handlers and conclusion values. */

import type { ConditionRegistry } from "../conditions";
import { matchGlob } from "../glob";
import type { AutomationEvent } from "../types";

export const DEFAULT_GITHUB_CONCLUSION = "success" as const;

const SHARED_GITHUB_CONCLUSIONS = [
  DEFAULT_GITHUB_CONCLUSION,
  "failure",
  "neutral",
  "cancelled",
  "timed_out",
  "action_required",
  "stale",
] as const;

export const CHECK_SUITE_CONCLUSIONS = [
  ...SHARED_GITHUB_CONCLUSIONS,
  "skipped",
  "startup_failure",
] as const;

export const WORKFLOW_RUN_CONCLUSIONS = [...SHARED_GITHUB_CONCLUSIONS, "skipped"] as const;

const NO_GITHUB_CONCLUSIONS: readonly string[] = [];

export function getGitHubConclusionOptions(eventType?: string): readonly string[] {
  if (eventType === "check_suite.completed") return CHECK_SUITE_CONCLUSIONS;
  if (eventType === "workflow_run.completed") return WORKFLOW_RUN_CONCLUSIONS;
  return NO_GITHUB_CONCLUSIONS;
}

function validateGitHubConclusion(condition: { value: string }, eventType?: string): string | null {
  return getGitHubConclusionOptions(eventType).includes(condition.value)
    ? null
    : `Invalid conclusion: ${condition.value}`;
}

function evaluateGitHubConclusion(condition: { value: string }, event: AutomationEvent): boolean {
  if (event.source !== "github") return true;
  return (event.conclusion ?? event.checkConclusion) === condition.value;
}

/** Match one branch name against a condition's exact list or glob patterns. */
function matchesPatterns(
  condition: { operator: string; value: string[] },
  branch: string | undefined
): boolean {
  if (!branch) return false;
  if (condition.operator === "exact") return condition.value.includes(branch);
  return condition.value.some((pattern) => matchGlob(pattern, branch));
}

export const githubConditions = {
  branch: {
    appliesTo: ["github"] as const,
    validate(condition) {
      return condition.value.length === 0 ? "At least one branch pattern required" : null;
    },
    evaluate(condition, event) {
      if (event.source !== "github") return true;
      return matchesPatterns(condition, event.branch);
    },
  },
  target_branch: {
    appliesTo: ["github"] as const,
    validate(condition) {
      return condition.value.length === 0 ? "At least one target branch pattern required" : null;
    },
    evaluate(condition, event) {
      if (event.source !== "github") return true;
      return matchesPatterns(condition, event.targetBranch);
    },
  },
  // No GitHub webhook payload carries a file list, so no normalizer ever sets
  // `changedFiles` and no catalog entry offers this condition. The handler and
  // its schema variant stay so persisted configs still parse; the empty
  // `appliesTo` is what says no source can answer it.
  path_glob: {
    appliesTo: [] as const,
    validate(condition) {
      return condition.value.length === 0 ? "At least one path pattern required" : null;
    },
    evaluate(condition, event) {
      if (event.source !== "github") return true;
      const changedFiles = event.changedFiles;
      if (!changedFiles?.length) return false;
      return condition.value.some((glob) => changedFiles.some((file) => matchGlob(glob, file)));
    },
  },
  conclusion: {
    appliesTo: ["github"] as const,
    validate: validateGitHubConclusion,
    evaluate: evaluateGitHubConclusion,
  },
  check_conclusion: {
    appliesTo: ["github"] as const,
    validate: validateGitHubConclusion,
    evaluate: evaluateGitHubConclusion,
  },
  workflow_name: {
    appliesTo: ["github"] as const,
    validate(condition) {
      return condition.value.trim().length === 0 ? "Workflow name is required" : null;
    },
    evaluate(condition, event) {
      if (event.source !== "github") return true;
      return event.workflowName === condition.value;
    },
  },
} satisfies Partial<ConditionRegistry>;
