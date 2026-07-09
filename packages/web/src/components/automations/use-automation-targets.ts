"use client";

import { useCallback, useMemo, useEffect, useState } from "react";
import { MAX_AUTOMATION_REPOSITORIES, type AutomationRepositoryInput } from "@open-inspect/shared";
import { parseRepoFullName, type SessionTarget } from "@/lib/session-target";

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

type SelectionMode = "single" | "multiple";

/** Selection key for a repository: the lowercase full name, as the API stores it. */
function repositoryKey(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`.toLowerCase();
}

function repoNamesOf(targets: AutomationSessionTarget[]): string[] {
  return targets.flatMap((target) => (target.kind === "repo" ? [target.repoFullName] : []));
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameTargetList(a: AutomationSessionTarget[], b: AutomationSessionTarget[]): boolean {
  return (
    a.length === b.length &&
    a.every((target, index) => {
      const other = b[index];
      return target.kind === "repo"
        ? other.kind === "repo" && other.repoFullName === target.repoFullName
        : other.kind === "environment" && other.environmentId === target.environmentId;
    })
  );
}

/**
 * Leaving multi-select keeps one target: the first repository, or the first
 * environment when only environments are selected.
 */
function collapseToSingleTarget(targets: AutomationSessionTarget[]): AutomationSessionTarget[] {
  const firstRepository = targets.find((target) => target.kind === "repo");
  return firstRepository ? [firstRepository] : targets.slice(0, 1);
}

export interface UseAutomationTargetsOptions {
  /** Stored selection hydrated in edit mode (or a template pre-fill). */
  initialRepositories: AutomationRepositoryInput[];
  initialEnvironmentIds: string[];
  /**
   * Multi-target selections are schedule-only (the server rejects them for
   * event triggers), so multi-select mode only exists there.
   */
  multiRepoAllowed: boolean;
  /**
   * Repo-scoped triggers stay bound to the webhook's repository: exactly one
   * repository, no environments, no repo-less selection.
   */
  repositoryRequired: boolean;
  repos: Array<{ fullName: string; defaultBranch: string }>;
}

export interface UseAutomationTargetsResult {
  /** Lowercase repository full names of the selection, in target order. */
  selectedRepoNames: string[];
  /** Environment ids of the selection, in target order. */
  selectedEnvironmentIds: string[];
  targetCount: number;
  /** Whether the selection is exactly one repository (the branch-pickable shape). */
  usesSingleRepository: boolean;
  /** Owner/name of the sole selected repository, for the branch fetch. */
  selectedRepository: { owner: string; name: string } | null;
  multipleSelectionEnabled: boolean;
  baseBranch: string;
  setBaseBranch: (branch: string) => void;
  /** Single-select replaces the selection; multi-select toggles up to the cap. */
  toggleRepository: (repoFullName: string) => void;
  toggleEnvironment: (environmentId: string) => void;
  /** The "No repository" selection; ignored while a repository is required. */
  clearTargets: () => void;
  /** Switches single/multi-select, collapsing a multi-selection to one target. */
  toggleSelectionMode: () => void;
  /** The `repositories` payload field: full selection with branch rules applied. */
  buildRepositoriesPayload: () => AutomationRepositoryInput[];
}

/**
 * Owns the automation form's target selection: the session-target list and its
 * hydration, single/multi selection mode, every selection transition, base
 * branch state coupled to those transitions, and the payload derivation. The
 * form renders from the derived views and never mutates the selection
 * directly.
 */
export function useAutomationTargets(
  options: UseAutomationTargetsOptions
): UseAutomationTargetsResult {
  const {
    initialRepositories,
    initialEnvironmentIds,
    multiRepoAllowed,
    repositoryRequired,
    repos,
  } = options;

  // The fan-out selection as one ordered list of session targets; repositories
  // and environments hydrate in selection order within each kind.
  const [selectedTargets, setSelectedTargets] = useState<AutomationSessionTarget[]>(() => [
    ...initialRepositories.map(
      (repository): AutomationSessionTarget => ({
        kind: "repo",
        repoFullName: repositoryKey(repository.repoOwner, repository.repoName),
      })
    ),
    ...initialEnvironmentIds.map(
      (environmentId): AutomationSessionTarget => ({ kind: "environment", environmentId })
    ),
  ]);
  const [selectionMode, setSelectionMode] = useState<SelectionMode>(() =>
    // Combined count: a lone-repo default here would let the single-select
    // collapse effect silently drop hydrated environment targets on edit.
    initialRepositories.length + initialEnvironmentIds.length > 1 ? "multiple" : "single"
  );
  const [baseBranch, setBaseBranch] = useState(() =>
    initialRepositories.length === 1 ? (initialRepositories[0].baseBranch ?? "") : ""
  );

  const multipleSelectionEnabled = multiRepoAllowed && selectionMode === "multiple";

  const findRepo = useCallback(
    (key: string) => repos.find((repo) => repo.fullName.toLowerCase() === key),
    [repos]
  );

  // The single mutation path for the selection. Branch policy is decided here
  // from the transition itself, never by callers picking a setter:
  // - Repository membership changed: exactly one selected repository pins
  //   baseBranch to its default, anything else clears it.
  // - Identical selection (a single-select re-click of the current target):
  //   treated as an explicit re-selection, so "selecting a repository resets
  //   this to that repo's default branch" holds even for the same repository.
  // - Otherwise (an environment-only change): baseBranch is left alone so a
  //   branch pick survives adding and removing environments around its repo.
  const commitTargets = useCallback(
    (nextTargets: AutomationSessionTarget[]) => {
      setSelectedTargets(nextTargets);
      const currentRepoNames = repoNamesOf(selectedTargets);
      const nextRepoNames = repoNamesOf(nextTargets);
      const membershipUnchanged = sameStringList(currentRepoNames, nextRepoNames);
      const reselectedCurrent = membershipUnchanged && sameTargetList(selectedTargets, nextTargets);
      if (membershipUnchanged && !reselectedCurrent) return;
      setBaseBranch(
        nextRepoNames.length === 1 ? (findRepo(nextRepoNames[0])?.defaultBranch ?? "") : ""
      );
    },
    [findRepo, selectedTargets]
  );

  useEffect(() => {
    if (!multiRepoAllowed && selectionMode === "multiple") {
      setSelectionMode("single");
    }
  }, [multiRepoAllowed, selectionMode]);

  // Repo-scoped triggers stay bound to the webhook's repository, so any
  // environment targets (e.g. hydrated before a trigger-type change) drop out.
  useEffect(() => {
    if (!repositoryRequired) return;
    if (!selectedTargets.some((target) => target.kind === "environment")) return;
    commitTargets(selectedTargets.filter((target) => target.kind === "repo"));
  }, [commitTargets, repositoryRequired, selectedTargets]);

  useEffect(() => {
    if (multipleSelectionEnabled || selectedTargets.length <= 1) return;
    commitTargets(collapseToSingleTarget(selectedTargets));
  }, [commitTargets, multipleSelectionEnabled, selectedTargets]);

  const selectedRepoNames = useMemo(() => repoNamesOf(selectedTargets), [selectedTargets]);
  const selectedEnvironmentIds = useMemo(
    () =>
      selectedTargets.flatMap((target) =>
        target.kind === "environment" ? [target.environmentId] : []
      ),
    [selectedTargets]
  );
  const targetCount = selectedTargets.length;
  const usesSingleRepository = selectedTargets.length === 1 && selectedTargets[0].kind === "repo";
  const selectedRepoName = selectedRepoNames[0] ?? "";
  const selectedRepository = usesSingleRepository ? parseRepoFullName(selectedRepoName) : null;

  const toggleRepository = useCallback(
    (repoFullName: string) => {
      const target: AutomationSessionTarget = {
        kind: "repo",
        repoFullName: repoFullName.toLowerCase(),
      };
      if (!multipleSelectionEnabled) {
        commitTargets([target]);
        return;
      }

      const selected = selectedRepoNames.includes(target.repoFullName);
      if (!selected && targetCount >= MAX_AUTOMATION_REPOSITORIES) return;
      commitTargets(
        selected
          ? selectedTargets.filter(
              (entry) => !(entry.kind === "repo" && entry.repoFullName === target.repoFullName)
            )
          : [...selectedTargets, target]
      );
    },
    [commitTargets, multipleSelectionEnabled, selectedRepoNames, selectedTargets, targetCount]
  );

  const toggleEnvironment = useCallback(
    (environmentId: string) => {
      const target: AutomationSessionTarget = { kind: "environment", environmentId };
      if (!multipleSelectionEnabled) {
        commitTargets([target]);
        return;
      }

      const selected = selectedEnvironmentIds.includes(environmentId);
      if (!selected && targetCount >= MAX_AUTOMATION_REPOSITORIES) return;
      commitTargets(
        selected
          ? selectedTargets.filter(
              (entry) => !(entry.kind === "environment" && entry.environmentId === environmentId)
            )
          : [...selectedTargets, target]
      );
    },
    [commitTargets, multipleSelectionEnabled, selectedEnvironmentIds, selectedTargets, targetCount]
  );

  const clearTargets = useCallback(() => {
    if (repositoryRequired) return;
    commitTargets([]);
  }, [commitTargets, repositoryRequired]);

  const toggleSelectionMode = useCallback(() => {
    if (!multiRepoAllowed) return;

    if (selectionMode === "multiple") {
      setSelectionMode("single");
      if (selectedTargets.length > 1) {
        commitTargets(collapseToSingleTarget(selectedTargets));
      }
      return;
    }

    setSelectionMode("multiple");
  }, [commitTargets, multiRepoAllowed, selectionMode, selectedTargets]);

  const buildRepositoriesPayload = useCallback(
    (): AutomationRepositoryInput[] =>
      selectedRepoNames.map((key) => {
        const [entryOwner = "", entryName = ""] = key.split("/");
        const entry: AutomationRepositoryInput = { repoOwner: entryOwner, repoName: entryName };
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
      }),
    [baseBranch, initialRepositories, selectedRepoNames, usesSingleRepository]
  );

  return {
    selectedRepoNames,
    selectedEnvironmentIds,
    targetCount,
    usesSingleRepository,
    selectedRepository,
    multipleSelectionEnabled,
    baseBranch,
    setBaseBranch,
    toggleRepository,
    toggleEnvironment,
    clearTargets,
    toggleSelectionMode,
    buildRepositoriesPayload,
  };
}
