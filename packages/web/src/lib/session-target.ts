/**
 * The new-session picker's target selection: nothing, a single repository
 * (today's behavior, branch dropdown included), a named environment, or an
 * ad-hoc ordered repository list ([0] = primary). The three launchable forms
 * map onto the mutually exclusive modes of createSessionRequestSchema —
 * buildSessionTargetRequestFields emits exactly one mode's fields so the
 * exclusivity refinement can never trip on picker-built requests.
 */

import { parseRepositoryFullName } from "@open-inspect/shared";

export type SessionTarget =
  | { kind: "none" }
  | { kind: "repo"; repoFullName: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "repos"; repoFullNames: string[] };

export const NO_REPOSITORY_OPTION_VALUE = "__no_repository__";
export const MULTIPLE_REPOSITORIES_OPTION_VALUE = "__multiple_repositories__";
const ENVIRONMENT_OPTION_PREFIX = "env:";

export function environmentOptionValue(environmentId: string): string {
  return `${ENVIRONMENT_OPTION_PREFIX}${environmentId}`;
}

/**
 * The environment id encoded in an `env:<id>` option value, or null for any
 * other value. The inverse of {@link environmentOptionValue} — for callers
 * (like the Slack routing-rules settings) that only deal in repo/environment
 * values and must not inherit the picker's sentinel semantics.
 */
export function parseEnvironmentOptionValue(value: string): string | null {
  return value.startsWith(ENVIRONMENT_OPTION_PREFIX)
    ? value.slice(ENVIRONMENT_OPTION_PREFIX.length)
    : null;
}

export function getTargetSelectValue(target: SessionTarget | null): string {
  if (!target) return "";
  switch (target.kind) {
    case "none":
      return NO_REPOSITORY_OPTION_VALUE;
    case "repo":
      return target.repoFullName;
    case "environment":
      return environmentOptionValue(target.environmentId);
    case "repos":
      return MULTIPLE_REPOSITORIES_OPTION_VALUE;
  }
}

/**
 * Parse a picker option value back into a target. The multi-repository
 * sentinel seeds the list from the previous selection so switching modes
 * keeps the current repo instead of starting empty.
 */
export function parseTargetSelectValue(
  value: string,
  previous: SessionTarget | null
): SessionTarget {
  if (value === NO_REPOSITORY_OPTION_VALUE) return { kind: "none" };
  if (value === MULTIPLE_REPOSITORIES_OPTION_VALUE) {
    if (previous?.kind === "repos") return previous;
    return {
      kind: "repos",
      repoFullNames: previous?.kind === "repo" ? [previous.repoFullName.toLowerCase()] : [],
    };
  }
  const environmentId = parseEnvironmentOptionValue(value);
  if (environmentId !== null) {
    return { kind: "environment", environmentId };
  }
  return { kind: "repo", repoFullName: value };
}

/**
 * Identity of a selection for the sandbox-warming config check — unlike
 * getTargetSelectValue it distinguishes different ad-hoc lists, so editing
 * the list invalidates a warmed session.
 */
export function getTargetConfigKey(target: SessionTarget | null): string {
  if (!target) return "";
  return target.kind === "repos"
    ? `repos:${target.repoFullNames.join(",")}`
    : getTargetSelectValue(target);
}

/** Whether the selection is complete enough to create a session from. */
export function isSessionTargetLaunchable(target: SessionTarget | null): boolean {
  if (!target) return false;
  return target.kind !== "repos" || target.repoFullNames.length > 0;
}

/**
 * The target's fields for the POST /api/sessions body: exactly one of the
 * scalar repo form, `environmentId`, or `repositories` (design §5.5). Mirrors
 * the mutually exclusive modes of createSessionRequestSchema.
 */
export type SessionTargetRequestFields =
  | { repoOwner: null; repoName: null }
  | { repoOwner: string; repoName: string; branch?: string }
  | { environmentId: string }
  | { repositories: Array<{ repoOwner: string; repoName: string }> };

export function buildSessionTargetRequestFields(
  target: SessionTarget,
  selectedBranch: string
): SessionTargetRequestFields {
  switch (target.kind) {
    case "none":
      return { repoOwner: null, repoName: null };
    case "repo": {
      const repository = parseRepositoryFullName(target.repoFullName);
      if (!repository) return { repoOwner: null, repoName: null };
      return {
        repoOwner: repository.repoOwner,
        repoName: repository.repoName,
        branch: selectedBranch || undefined,
      };
    }
    case "environment":
      return { environmentId: target.environmentId };
    case "repos":
      return {
        repositories: target.repoFullNames
          .map(parseRepositoryFullName)
          .filter((repository) => repository !== null),
      };
  }
}
