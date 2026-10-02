"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { parseRepositoryFullName } from "@open-inspect/shared/types/repositories";
import type { Environment } from "@open-inspect/shared/types/environments";
import type { ImageBuildStatus } from "@open-inspect/shared/types/image-builds";
import type { ComboboxGroup, ComboboxOption } from "@/components/ui/combobox";
import { useBranches } from "@/hooks/use-branches";
import { useEnvironments } from "@/hooks/use-environments";
import { useRepos, type Repo } from "@/hooks/use-repos";
import {
  foldEnabledRepoScopeIds,
  foldImageBuildStatusByScope,
  imageBuildScopeKey,
  repoImageBuildScopeId,
} from "@/lib/image-builds";
import { NO_REPOSITORY_LABEL } from "@/lib/repo-label";
import { useImageBuilds } from "@/hooks/use-image-builds";
import {
  type SessionTarget,
  type SessionTargetRequestFields,
  NO_REPOSITORY_OPTION_VALUE,
  MULTIPLE_REPOSITORIES_OPTION_VALUE,
  buildSessionTargetRequestFields,
  environmentOptionValue,
  getTargetConfigKey,
  getTargetSelectValue,
  isSessionTargetLaunchable,
  parseTargetSelectValue,
} from "@/lib/session-target";

// Holds the picker's last-selected target as a select value — a repo fullName
// or an `env:<id>` environment value. The key literal predates environments
// (it stored only repo names) and is kept so stored repo values keep working.
const LAST_SELECTED_TARGET_STORAGE_KEY = "open-inspect-last-selected-repo";

// Prebuild annotation labels, shared by the environment and repository
// subtitles so the two scopes read identically.
const PREBUILD_ANNOTATION_READY = "prebuilt";
const PREBUILD_ANNOTATION_BUILDING = "prebuild building";
const PREBUILD_ANNOTATION_FAILED = "prebuild failed";
const PREBUILD_ANNOTATION_ENABLED = "prebuilds on";

/**
 * The prebuild annotation for a scope, or null when prebuilds are off for it
 * (the common case must stay unannotated). `status` is the scope's folded build
 * status; a prebuild-enabled scope with no current build row is undefined here
 * and falls back to "prebuilds on".
 */
function prebuildAnnotation(
  prebuildEnabled: boolean,
  status: ImageBuildStatus | undefined
): string | null {
  if (!prebuildEnabled) return null;
  if (status === "ready") return PREBUILD_ANNOTATION_READY;
  if (status === "building") return PREBUILD_ANNOTATION_BUILDING;
  if (status === "failed") return PREBUILD_ANNOTATION_FAILED;
  return PREBUILD_ANNOTATION_ENABLED;
}

function withAnnotation(base: string, annotation: string | null): string {
  return annotation ? `${base} · ${annotation}` : base;
}

/** Picker subtitle for an environment: repository count plus prebuild state. */
export function describeEnvironment(
  environment: Environment,
  imageStatusByScope: Map<string, ImageBuildStatus>
): string {
  const count = environment.repositories.length;
  const base = `${count} ${count === 1 ? "repository" : "repositories"}`;
  const status = imageStatusByScope.get(imageBuildScopeKey("environment", environment.id));
  return withAnnotation(base, prebuildAnnotation(environment.prebuildEnabled, status));
}

/**
 * Picker subtitle for a repository: owner (and privacy) plus prebuild state.
 *
 * Branch semantics: a repo image is only built for the repo's DEFAULT branch —
 * a session on any other branch fingerprint-misses to the base image. This
 * annotation describes the default-branch prebuild state and is intentionally
 * static: it does not react to the picker's branch selector (which itself
 * defaults to the default branch). Enablement and the fold-map lookup share the
 * repo scope id (lowercased owner/name) via `repoImageBuildScopeId`.
 */
export function describeRepository(
  repo: Repo,
  imageStatusByScope: Map<string, ImageBuildStatus>,
  prebuildEnabledRepoScopeIds: Set<string>
): string {
  const base = `${repo.owner}${repo.private ? " • private" : ""}`;
  const scopeId = repoImageBuildScopeId(repo.owner, repo.name);
  const status = imageStatusByScope.get(imageBuildScopeKey("repo", scopeId));
  return withAnnotation(base, prebuildAnnotation(prebuildEnabledRepoScopeIds.has(scopeId), status));
}

/** Render contract for SessionTargetPicker: the target/branch/multi-select controls. */
export interface SessionTargetPickerProps {
  /** The visible draft, including an explicit target that cannot currently launch. */
  sessionTarget: SessionTarget | null;
  targetSelectValue: string;
  targetOptions: ComboboxOption[] | ComboboxGroup[];
  displayTargetName: string;
  onTargetSelectValueChange: (value: string) => void;
  onMultiSelectionChange: (repoFullNames: string[]) => void;
  selectedBranch: string;
  setSelectedBranch: (branch: string) => void;
  branches: { name: string }[];
  loadingBranches: boolean;
  repos: Repo[];
  loadingRepos: boolean;
  repositoryGrantError: string | null;
  selectionError: string | null;
}

/** Launch-facing selection state for the page: warming identity and request construction. */
export interface SessionTargetSelection {
  sessionTarget: SessionTarget | null;
  selectedBranch: string;
  repos: Repo[];
  loadingRepos: boolean;
  teamHasRepositoryGrants?: boolean;
  repositoryGrantError: string | null;
  /** The selected repository's metadata when the target is a single repo. */
  selectedRepo: Repo | undefined;
  isLaunchable: boolean;
  /** Selection identity for the sandbox-warming config check. */
  configKey: string;
  /** Request-body fields for the current target, or null when not launchable. */
  buildRequestFields: () => SessionTargetRequestFields | null;
  /** Everything SessionTargetPicker needs to render the controls. */
  pickerProps: SessionTargetPickerProps;
}

function targetIsAvailable(
  target: SessionTarget | null,
  repos: Repo[],
  environments: Environment[]
): boolean {
  if (!target) return false;
  if (target.kind === "repo") return repos.some((repo) => repo.fullName === target.repoFullName);
  if (target.kind === "environment")
    return environments.some((environment) => environment.id === target.environmentId);
  if (target.kind === "repos")
    return target.repoFullNames.every((fullName) =>
      repos.some((repo) => repo.fullName.toLowerCase() === fullName.toLowerCase())
    );
  return true;
}

/**
 * Owns the new-session target selection: SessionTarget state, the unified
 * environment/repository option list, branch and multi-repo handling, and
 * request-field construction. The controls render through SessionTargetPicker
 * via `pickerProps`; the page keeps model, prompt, and warming.
 */
export function useSessionTargetPicker({
  teamId = null,
  defaultEnvironmentId = null,
}: {
  teamId?: string | null;
  defaultEnvironmentId?: string | null;
} = {}): SessionTargetSelection {
  const {
    repos: catalogRepos,
    loading: loadingRepos,
    error: reposError,
    teamHasRepositoryGrants,
  } = useRepos(true, teamId);
  const repos = useMemo(
    () => (teamId && reposError ? [] : catalogRepos),
    [teamId, reposError, catalogRepos]
  );
  const noRepositoryGrants =
    !!teamId && !loadingRepos && !reposError && teamHasRepositoryGrants === false;
  const repositoryGrantError = noRepositoryGrants ? "This team has no repository grants." : null;
  const {
    environments,
    loading: loadingEnvironments,
    error: environmentsError,
  } = useEnvironments({ teamId });
  const [draftTarget, setSessionTarget] = useState<SessionTarget | null>(null);
  const [selectedBranch, updateSelectedBranch] = useState<string>("");
  const [selectionContext, setSelectionContext] = useState({ teamId, defaultEnvironmentId });
  const [hasExplicitSelection, setHasExplicitSelection] = useState(false);
  const [selectionInvalidated, setSelectionInvalidated] = useState(false);
  const targetCatalogError =
    draftTarget?.kind === "environment"
      ? environmentsError
      : draftTarget?.kind === "repo" || draftTarget?.kind === "repos"
        ? reposError
        : null;
  const explicitTargetUnavailable =
    hasExplicitSelection &&
    !!draftTarget &&
    !loadingRepos &&
    !loadingEnvironments &&
    !targetCatalogError &&
    !targetIsAvailable(draftTarget, repos, environments);
  const selectionError =
    selectionInvalidated || explicitTargetUnavailable
      ? "Your selected target is no longer available. Choose a target again."
      : null;
  // Never launch a previous team's target before its new catalogs reconcile.
  const sessionTarget =
    !loadingRepos &&
    !loadingEnvironments &&
    selectionContext.teamId === teamId &&
    !(teamId && draftTarget?.kind === "none" && !hasExplicitSelection) &&
    (hasExplicitSelection || selectionContext.defaultEnvironmentId === defaultEnvironmentId) &&
    !selectionError &&
    !(hasExplicitSelection && targetCatalogError) &&
    targetIsAvailable(draftTarget, repos, environments)
      ? draftTarget
      : null;
  const pickerTarget = hasExplicitSelection ? draftTarget : sessionTarget;

  const selectedRepository =
    sessionTarget?.kind === "repo" ? parseRepositoryFullName(sessionTarget.repoFullName) : null;
  const { branches, loading: loadingBranches } = useBranches(
    selectedRepository?.repoOwner ?? "",
    selectedRepository?.repoName ?? ""
  );

  // Prebuild status for the repository and environment options: the unified
  // cross-scope feed (repo and environment scopes, failed rows included), one
  // call across all of them, folded to one status per scope. Fetched whenever
  // there is anything to annotate.
  const { data: imageBuildsData } = useImageBuilds(environments.length > 0 || repos.length > 0);
  const imageStatusByScope = useMemo(
    () => foldImageBuildStatusByScope(imageBuildsData?.images ?? [], imageBuildsData?.units ?? []),
    [imageBuildsData]
  );
  // Persisted repo prebuild scope ids, folded next to the feed shape so this
  // hook doesn't re-encode the lowercased-repo-key invariant.
  const prebuildEnabledRepoScopeIds = useMemo(
    () => foldEnabledRepoScopeIds(imageBuildsData?.enabledRepos ?? []),
    [imageBuildsData]
  );

  // Team defaults win over stored preferences, but never over a draft's explicit choice.
  useEffect(() => {
    if (loadingRepos || loadingEnvironments) return;

    if (hasExplicitSelection) {
      // Only a successful catalog can invalidate a choice; restoration never confirms it.
      if (explicitTargetUnavailable && !selectionInvalidated) setSelectionInvalidated(true);
      if (!targetCatalogError && selectionContext.teamId !== teamId) {
        setSelectionContext({ teamId, defaultEnvironmentId });
      }
      return;
    }
    if (sessionTarget) return;

    let nextTarget: SessionTarget | null = null;
    if (
      defaultEnvironmentId &&
      environments.some((environment) => environment.id === defaultEnvironmentId)
    ) {
      nextTarget = { kind: "environment", environmentId: defaultEnvironmentId };
    }

    if (!nextTarget) {
      const storedValue = localStorage.getItem(LAST_SELECTED_TARGET_STORAGE_KEY);
      const storedTarget = storedValue ? parseTargetSelectValue(storedValue, null) : null;
      if (
        targetIsAvailable(storedTarget, repos, environments) &&
        !(teamId && storedTarget?.kind === "none")
      ) {
        nextTarget = storedTarget;
      } else if (repos[0]) {
        nextTarget = { kind: "repo", repoFullName: repos[0].fullName };
      } else if (!teamId) {
        nextTarget = { kind: "none" };
      }
    }
    if (!nextTarget) return;

    if (nextTarget.kind === "repo") {
      if (draftTarget?.kind !== "repo" || draftTarget.repoFullName !== nextTarget.repoFullName) {
        updateSelectedBranch(
          repos.find((repo) => repo.fullName === nextTarget.repoFullName)?.defaultBranch ?? ""
        );
      }
    } else updateSelectedBranch("");
    setSessionTarget(nextTarget);
    setSelectionContext({ teamId, defaultEnvironmentId });
  }, [
    defaultEnvironmentId,
    draftTarget,
    environments,
    explicitTargetUnavailable,
    hasExplicitSelection,
    loadingEnvironments,
    loadingRepos,
    repos,
    selectionContext.teamId,
    selectionInvalidated,
    sessionTarget,
    targetCatalogError,
    teamId,
  ]);

  // Persist launchable, restorable selections: repos and environments. Ad-hoc
  // lists and "no repository" keep whatever was stored before them.
  useEffect(() => {
    if (sessionTarget?.kind !== "repo" && sessionTarget?.kind !== "environment") return;
    localStorage.setItem(LAST_SELECTED_TARGET_STORAGE_KEY, getTargetSelectValue(sessionTarget));
  }, [sessionTarget]);

  const onTargetSelectValueChange = useCallback(
    (value: string) => {
      setHasExplicitSelection(true);
      setSelectionInvalidated(false);
      const nextTarget = parseTargetSelectValue(value, draftTarget);
      setSessionTarget(nextTarget);
      setSelectionContext({ teamId, defaultEnvironmentId });
      if (nextTarget.kind !== "repo") {
        updateSelectedBranch("");
        return;
      }
      const repo = repos.find((r) => r.fullName === nextTarget.repoFullName);
      if (repo) updateSelectedBranch(repo.defaultBranch);
    },
    [defaultEnvironmentId, draftTarget, repos, teamId]
  );

  const onMultiSelectionChange = useCallback(
    (repoFullNames: string[]) => {
      setHasExplicitSelection(true);
      setSelectionInvalidated(false);
      setSessionTarget({ kind: "repos", repoFullNames });
      setSelectionContext({ teamId, defaultEnvironmentId });
    },
    [defaultEnvironmentId, teamId]
  );

  const setSelectedBranch = useCallback((branch: string) => {
    setHasExplicitSelection(true);
    updateSelectedBranch(branch);
  }, []);

  const buildRequestFields = useCallback((): SessionTargetRequestFields | null => {
    if (!sessionTarget || !isSessionTargetLaunchable(sessionTarget)) return null;
    return buildSessionTargetRequestFields(sessionTarget, selectedBranch);
  }, [sessionTarget, selectedBranch]);

  const selectedRepo =
    sessionTarget?.kind === "repo"
      ? repos.find((r) => r.fullName === sessionTarget.repoFullName)
      : undefined;
  const selectedEnvironment =
    pickerTarget?.kind === "environment"
      ? environments.find((environment) => environment.id === pickerTarget.environmentId)
      : undefined;
  const displayTargetName = (() => {
    switch (pickerTarget?.kind) {
      case "none":
        return NO_REPOSITORY_LABEL;
      case "repo":
        return (
          repos.find((repo) => repo.fullName === pickerTarget.repoFullName)?.name ??
          pickerTarget.repoFullName
        );
      case "environment":
        return selectedEnvironment?.name ?? `Environment (${pickerTarget.environmentId})`;
      case "repos": {
        const count = pickerTarget.repoFullNames.length;
        if (count === 0) return "Select repositories";
        return `${count} ${count === 1 ? "repository" : "repositories"}`;
      }
      default:
        return "Select repo";
    }
  })();

  const repositoryOptions: ComboboxOption[] = [
    {
      value: NO_REPOSITORY_OPTION_VALUE,
      label: NO_REPOSITORY_LABEL,
      description: "Start without cloning a repository",
    },
    {
      value: MULTIPLE_REPOSITORIES_OPTION_VALUE,
      label: "Multiple repositories",
      description: "Pick an ad-hoc set of repositories",
    },
    ...repos.map((repo) => ({
      value: repo.fullName,
      label: repo.name,
      description: describeRepository(repo, imageStatusByScope, prebuildEnabledRepoScopeIds),
    })),
  ];
  // One unified list: environments (when any exist) alongside the repositories.
  const targetOptions: ComboboxOption[] | ComboboxGroup[] =
    environments.length > 0
      ? [
          {
            category: "Environments",
            options: environments.map((environment) => ({
              value: environmentOptionValue(environment.id),
              label: environment.name,
              description: describeEnvironment(environment, imageStatusByScope),
            })),
          },
          { category: "Repositories", options: repositoryOptions },
        ]
      : repositoryOptions;

  return {
    sessionTarget,
    selectedBranch,
    repos,
    loadingRepos,
    selectedRepo,
    teamHasRepositoryGrants,
    repositoryGrantError,
    isLaunchable: isSessionTargetLaunchable(sessionTarget),
    configKey: getTargetConfigKey(sessionTarget),
    buildRequestFields,
    pickerProps: {
      sessionTarget: pickerTarget,
      targetSelectValue: getTargetSelectValue(pickerTarget),
      targetOptions,
      displayTargetName,
      onTargetSelectValueChange,
      onMultiSelectionChange,
      selectedBranch,
      setSelectedBranch,
      branches,
      loadingBranches,
      repos,
      loadingRepos,
      repositoryGrantError,
      selectionError,
    },
  };
}
