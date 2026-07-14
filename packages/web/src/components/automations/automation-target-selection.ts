import {
  formatRepositoryFullName,
  parseRepositoryFullName,
  type AutomationRepositoryInput,
} from "@open-inspect/shared";
import type { SessionTarget } from "@/lib/session-target";

/**
 * One entry of the automation's fan-out selection, reusing the shared
 * session-target model (lib/session-target.ts). An automation targets an
 * ordered list of launchable session targets: each `repo` entry runs in its
 * own session and each `environment` entry opens one workspace session. The
 * empty list is the repo-less selection ("No repository"). Single-select mode
 * replaces the whole list, so repo/environment mutual exclusivity there is
 * structural rather than enforced by cross-clearing effects.
 */
export type AutomationSessionTarget = Extract<SessionTarget, { kind: "repo" | "environment" }>;

export type SelectionMode = "single" | "multiple";

/** Selection key for a repository: the lowercase full name, as the API stores it. */
function repositoryKey(repoOwner: string, repoName: string): string {
  return formatRepositoryFullName({ repoOwner, repoName }).toLowerCase();
}

/**
 * The stored selection as a target list: repositories first, then
 * environments, each in stored order.
 */
export function hydrateTargets(
  initialRepositories: AutomationRepositoryInput[],
  initialEnvironmentIds: string[]
): AutomationSessionTarget[] {
  return [
    ...initialRepositories.map(
      (repository): AutomationSessionTarget => ({
        kind: "repo",
        repoFullName: repositoryKey(repository.repoOwner, repository.repoName),
      })
    ),
    ...initialEnvironmentIds.map(
      (environmentId): AutomationSessionTarget => ({ kind: "environment", environmentId })
    ),
  ];
}

/**
 * A hydrated selection with more than one target opens in multi-select mode.
 * The count combines repositories and environments: a lone-repo rule here
 * would let the single-select collapse effect silently drop hydrated
 * environment targets on edit.
 */
export function initialSelectionMode(
  initialRepositories: AutomationRepositoryInput[],
  initialEnvironmentIds: string[]
): SelectionMode {
  return initialRepositories.length + initialEnvironmentIds.length > 1 ? "multiple" : "single";
}

/** The hydrated branch: the stored branch when exactly one repository is stored. */
export function initialBaseBranch(initialRepositories: AutomationRepositoryInput[]): string {
  return initialRepositories.length === 1 ? (initialRepositories[0].baseBranch ?? "") : "";
}

/** Lowercase repository full names of the selection, in target order. */
export function repoNamesOf(targets: AutomationSessionTarget[]): string[] {
  return targets.flatMap((target) => (target.kind === "repo" ? [target.repoFullName] : []));
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameTarget(a: AutomationSessionTarget, b: AutomationSessionTarget): boolean {
  return a.kind === "repo"
    ? b.kind === "repo" && b.repoFullName === a.repoFullName
    : b.kind === "environment" && b.environmentId === a.environmentId;
}

function sameTargetList(a: AutomationSessionTarget[], b: AutomationSessionTarget[]): boolean {
  return a.length === b.length && a.every((target, index) => sameTarget(target, b[index]));
}

/**
 * Leaving multi-select keeps one target: the first repository, or the first
 * environment when only environments are selected.
 */
export function collapseToSingleTarget(
  targets: AutomationSessionTarget[]
): AutomationSessionTarget[] {
  const firstRepository = targets.find((target) => target.kind === "repo");
  return firstRepository ? [firstRepository] : targets.slice(0, 1);
}

/**
 * Toggled multi-select membership: removes the target when selected, appends
 * it otherwise. Returns null when adding would exceed the cap.
 */
export function toggleTarget(
  targets: AutomationSessionTarget[],
  target: AutomationSessionTarget,
  cap: number
): AutomationSessionTarget[] | null {
  const selected = targets.some((entry) => sameTarget(entry, target));
  if (!selected && targets.length >= cap) return null;
  return selected ? targets.filter((entry) => !sameTarget(entry, target)) : [...targets, target];
}

/** Exactly one selected repository pins its default branch; anything else clears the branch. */
function pinnedBranchFor(
  repoNames: string[],
  repos: Array<{ fullName: string; defaultBranch: string }>
): string {
  if (repoNames.length !== 1) return "";
  return repos.find((repo) => repo.fullName.toLowerCase() === repoNames[0])?.defaultBranch ?? "";
}

/**
 * The branch policy for a selection transition: the next baseBranch value, or
 * null to leave the current value unchanged. Decided from the transition
 * itself, so callers never choose between branch-updating and branch-keeping
 * setters.
 */
export function nextBaseBranch(
  prevTargets: AutomationSessionTarget[],
  nextTargets: AutomationSessionTarget[],
  repos: Array<{ fullName: string; defaultBranch: string }>
): string | null {
  const prevRepoNames = repoNamesOf(prevTargets);
  const nextRepoNames = repoNamesOf(nextTargets);
  if (sameStringList(prevRepoNames, nextRepoNames)) {
    // Identical selection: a single-select re-click of the current target is
    // an explicit re-selection, so "selecting a repository resets this to that
    // repo's default branch" holds even for the same repository.
    if (sameTargetList(prevTargets, nextTargets)) return pinnedBranchFor(nextRepoNames, repos);
    // Environment-only change: leave a (possibly hidden) branch pick alone so
    // it survives adding and removing environments around its repository.
    return null;
  }
  // Repository membership changed: re-derive the branch from the new membership.
  return pinnedBranchFor(nextRepoNames, repos);
}

/** The `repositories` payload field: the full selection with branch rules applied. */
export function buildRepositoriesPayload(
  selectedRepoNames: string[],
  usesSingleRepository: boolean,
  baseBranch: string,
  initialRepositories: AutomationRepositoryInput[]
): AutomationRepositoryInput[] {
  return selectedRepoNames.map((key) => {
    const entry: AutomationRepositoryInput = parseRepositoryFullName(key) ?? {
      repoOwner: "",
      repoName: "",
    };
    if (usesSingleRepository) {
      if (baseBranch.trim()) entry.baseBranch = baseBranch.trim();
    } else {
      // Multi-repo selections have no branch picker; keep the branch each
      // already-selected repository had so an unrelated edit can't reset it.
      const existing = initialRepositories.find(
        (repository) => repositoryKey(repository.repoOwner, repository.repoName) === key
      );
      if (existing?.baseBranch) entry.baseBranch = existing.baseBranch;
    }
    return entry;
  });
}
