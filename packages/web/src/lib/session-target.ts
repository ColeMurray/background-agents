/**
 * The new-session picker's target selection: nothing, a single repository
 * (today's behavior, branch dropdown included), a named environment, or an
 * ad-hoc ordered repository list ([0] = primary). The three launchable forms
 * map onto the mutually exclusive modes of createSessionRequestSchema —
 * buildSessionTargetRequestFields emits exactly one mode's fields so the
 * exclusivity refinement can never trip on picker-built requests.
 */

export type SessionTarget =
  | { kind: "none" }
  | { kind: "repo"; repoFullName: string }
  | { kind: "environment"; environmentId: string }
  | { kind: "repos"; repoFullNames: string[] };

export const NO_REPOSITORY_OPTION_VALUE = "__no_repository__";
export const MULTIPLE_REPOSITORIES_OPTION_VALUE = "__multiple_repositories__";
const ENVIRONMENT_OPTION_PREFIX = "env:";

export function parseRepoFullName(repoFullName: string): { owner: string; name: string } | null {
  const [owner, name] = repoFullName.split("/");
  return owner && name ? { owner, name } : null;
}

export function environmentOptionValue(environmentId: string): string {
  return `${ENVIRONMENT_OPTION_PREFIX}${environmentId}`;
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
  if (value.startsWith(ENVIRONMENT_OPTION_PREFIX)) {
    return { kind: "environment", environmentId: value.slice(ENVIRONMENT_OPTION_PREFIX.length) };
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
 * scalar repo form, `environmentId`, or `repositories` (design §5.5).
 */
export function buildSessionTargetRequestFields(
  target: SessionTarget,
  selectedBranch: string
): Record<string, unknown> {
  switch (target.kind) {
    case "none":
      return { repoOwner: null, repoName: null };
    case "repo": {
      const repository = parseRepoFullName(target.repoFullName);
      if (!repository) return { repoOwner: null, repoName: null };
      return {
        repoOwner: repository.owner,
        repoName: repository.name,
        branch: selectedBranch || undefined,
      };
    }
    case "environment":
      return { environmentId: target.environmentId };
    case "repos":
      return {
        repositories: target.repoFullNames
          .map(parseRepoFullName)
          .filter(
            (repository): repository is { owner: string; name: string } => repository !== null
          )
          .map((repository) => ({ repoOwner: repository.owner, repoName: repository.name })),
      };
  }
}
