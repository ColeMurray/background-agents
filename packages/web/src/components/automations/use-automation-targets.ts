"use client";

import { useCallback, useMemo, useEffect, useState } from "react";
import {
  MAX_AUTOMATION_REPOSITORIES,
  parseRepositoryFullName,
  type AutomationRepositoryInput,
} from "@open-inspect/shared";
import {
  type AutomationSessionTarget,
  type SelectionMode,
  buildRepositoriesPayload,
  collapseToSingleTarget,
  hydrateTargets,
  initialBaseBranch,
  initialSelectionMode,
  nextBaseBranch,
  repoNamesOf,
  toggleTarget,
} from "./automation-target-selection";

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
  /** Structured identity of the sole selected repository, for the branch fetch. */
  selectedRepository: { repoOwner: string; repoName: string } | null;
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
 * selection rules themselves are pure functions in
 * automation-target-selection.ts; this hook wires them to React state. The
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

  // State: the ordered session-target list, the selection mode, and the branch.
  const [selectedTargets, setSelectedTargets] = useState<AutomationSessionTarget[]>(() =>
    hydrateTargets(initialRepositories, initialEnvironmentIds)
  );
  const [selectionMode, setSelectionMode] = useState<SelectionMode>(() =>
    initialSelectionMode(initialRepositories, initialEnvironmentIds)
  );
  const [baseBranch, setBaseBranch] = useState(() => initialBaseBranch(initialRepositories));

  const multipleSelectionEnabled = multiRepoAllowed && selectionMode === "multiple";

  // The single mutation path for the selection: every transition below commits
  // here, and nextBaseBranch decides the branch policy from the transition
  // itself — callers never choose between branch-updating and branch-keeping
  // setters.
  const commitTargets = useCallback(
    (nextTargets: AutomationSessionTarget[]) => {
      setSelectedTargets(nextTargets);
      const branch = nextBaseBranch(selectedTargets, nextTargets, repos);
      if (branch !== null) setBaseBranch(branch);
    },
    [repos, selectedTargets]
  );

  // Multi-select mode is schedule-only; leaving schedule forces single-select.
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

  // Single-select holds at most one target; collapse anything larger.
  useEffect(() => {
    if (multipleSelectionEnabled || selectedTargets.length <= 1) return;
    commitTargets(collapseToSingleTarget(selectedTargets));
  }, [commitTargets, multipleSelectionEnabled, selectedTargets]);

  // Per-kind views of the selection, in target order.
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
  const selectedRepository = usesSingleRepository
    ? parseRepositoryFullName(selectedRepoNames[0] ?? "")
    : null;

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
      const nextTargets = toggleTarget(selectedTargets, target, MAX_AUTOMATION_REPOSITORIES);
      if (nextTargets) commitTargets(nextTargets);
    },
    [commitTargets, multipleSelectionEnabled, selectedTargets]
  );

  const toggleEnvironment = useCallback(
    (environmentId: string) => {
      const target: AutomationSessionTarget = { kind: "environment", environmentId };
      if (!multipleSelectionEnabled) {
        commitTargets([target]);
        return;
      }
      const nextTargets = toggleTarget(selectedTargets, target, MAX_AUTOMATION_REPOSITORIES);
      if (nextTargets) commitTargets(nextTargets);
    },
    [commitTargets, multipleSelectionEnabled, selectedTargets]
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

  const buildPayload = useCallback(
    () =>
      buildRepositoriesPayload(
        selectedRepoNames,
        usesSingleRepository,
        baseBranch,
        initialRepositories
      ),
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
    buildRepositoriesPayload: buildPayload,
  };
}
