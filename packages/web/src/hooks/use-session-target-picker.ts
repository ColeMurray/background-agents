"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession } from "next-auth/react";
import useSWR from "swr";
import type { Environment } from "@open-inspect/shared";
import type { ComboboxGroup, ComboboxOption } from "@/components/ui/combobox";
import { useBranches } from "@/hooks/use-branches";
import { useEnvironments } from "@/hooks/use-environments";
import { useRepos, type Repo } from "@/hooks/use-repos";
import { NO_REPOSITORY_LABEL } from "@/lib/repo-label";
import { supportsRepoImages } from "@/lib/sandbox-provider";
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
  parseRepoFullName,
  parseTargetSelectValue,
} from "@/lib/session-target";

// Holds the picker's last-selected target as a select value — a repo fullName
// or an `env:<id>` environment value. The key literal predates environments
// (it stored only repo names) and is kept so stored repo values keep working.
const LAST_SELECTED_TARGET_STORAGE_KEY = "open-inspect-last-selected-repo";

interface EnvironmentImageStatusRow {
  environment_id: string;
  status: "building" | "ready" | "failed";
}

/** Picker subtitle for an environment: repository count plus prebuild state. */
function describeEnvironment(
  environment: Environment,
  imageStatusByEnvironment: Map<string, EnvironmentImageStatusRow["status"]>
): string {
  const count = environment.repositories.length;
  const base = `${count} ${count === 1 ? "repository" : "repositories"}`;
  if (!environment.prebuildEnabled) return base;
  const status = imageStatusByEnvironment.get(environment.id);
  if (status === "ready") return `${base} · prebuilt`;
  if (status === "building") return `${base} · prebuild building`;
  return `${base} · prebuilds on`;
}

/** Render contract for SessionTargetPicker: the target/branch/multi-select controls. */
export interface SessionTargetPickerProps {
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
}

/** Launch-facing selection state for the page: warming identity and request construction. */
export interface SessionTargetSelection {
  sessionTarget: SessionTarget | null;
  selectedBranch: string;
  repos: Repo[];
  loadingRepos: boolean;
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

/**
 * Owns the new-session target selection: SessionTarget state, the unified
 * environment/repository option list, branch and multi-repo handling, and
 * request-field construction. The controls render through SessionTargetPicker
 * via `pickerProps`; the page keeps model, prompt, and warming.
 */
export function useSessionTargetPicker(): SessionTargetSelection {
  const { status: sessionStatus } = useSession();
  const { repos, loading: loadingRepos } = useRepos();
  const { environments, loading: loadingEnvironments } = useEnvironments();
  const [sessionTarget, setSessionTarget] = useState<SessionTarget | null>(null);
  const [selectedBranch, setSelectedBranch] = useState<string>("");

  const selectedRepository =
    sessionTarget?.kind === "repo" ? parseRepoFullName(sessionTarget.repoFullName) : null;
  const { branches, loading: loadingBranches } = useBranches(
    selectedRepository?.owner ?? "",
    selectedRepository?.name ?? ""
  );

  // Prebuild status for the environment options (ready/building rows of
  // prebuild-enabled environments, one call across all of them).
  const { data: environmentImagesData } = useSWR<{ images: EnvironmentImageStatusRow[] }>(
    environments.length > 0 && supportsRepoImages() ? "/api/environment-images" : null
  );
  const imageStatusByEnvironment = useMemo(() => {
    const statusByEnvironment = new Map<string, EnvironmentImageStatusRow["status"]>();
    for (const row of environmentImagesData?.images ?? []) {
      if (row.status === "ready" || !statusByEnvironment.has(row.environment_id)) {
        statusByEnvironment.set(row.environment_id, row.status);
      }
    }
    return statusByEnvironment;
  }, [environmentImagesData]);

  // Restore the last-selected target once data loads. This effect commits a
  // target exactly once (the guard blocks any later correction), so a stored
  // environment must not fall through to the repo default while environments
  // are still loading — wait for the fetch to settle before deciding.
  useEffect(() => {
    if (sessionTarget) return;
    // Both data hooks gate their fetch on the auth session, and report
    // loading=false while it resolves — deciding in that window would read
    // empty lists as authoritative (e.g. classify a stored environment as
    // deleted, or lock in "no repository").
    if (sessionStatus === "loading") return;

    const storedValue = localStorage.getItem(LAST_SELECTED_TARGET_STORAGE_KEY);
    const storedTarget = storedValue ? parseTargetSelectValue(storedValue, null) : null;

    if (storedTarget?.kind === "environment") {
      if (loadingEnvironments) return;
      if (environments.some((environment) => environment.id === storedTarget.environmentId)) {
        setSessionTarget(storedTarget);
        return;
      }
      // The stored environment was deleted — fall through to the repo default.
    }

    if (repos.length > 0) {
      // A stored `env:<id>` value never matches a fullName, so a deleted
      // environment lands on repos[0] here like any other stale value.
      const hasStoredRepo = repos.some((repo) => repo.fullName === storedValue);
      const defaultRepo = (hasStoredRepo ? storedValue : repos[0].fullName) ?? repos[0].fullName;
      setSessionTarget({ kind: "repo", repoFullName: defaultRepo });
      const repo = repos.find((r) => r.fullName === defaultRepo);
      if (repo) setSelectedBranch(repo.defaultBranch);
      return;
    }

    if (!loadingRepos) {
      setSessionTarget({ kind: "none" });
    }
  }, [sessionStatus, loadingRepos, repos, loadingEnvironments, environments, sessionTarget]);

  // Persist launchable, restorable selections: repos and environments. Ad-hoc
  // lists and "no repository" keep whatever was stored before them.
  useEffect(() => {
    if (sessionTarget?.kind !== "repo" && sessionTarget?.kind !== "environment") return;
    localStorage.setItem(LAST_SELECTED_TARGET_STORAGE_KEY, getTargetSelectValue(sessionTarget));
  }, [sessionTarget]);

  const onTargetSelectValueChange = useCallback(
    (value: string) => {
      const nextTarget = parseTargetSelectValue(value, sessionTarget);
      setSessionTarget(nextTarget);
      if (nextTarget.kind !== "repo") {
        setSelectedBranch("");
        return;
      }
      const repo = repos.find((r) => r.fullName === nextTarget.repoFullName);
      if (repo) setSelectedBranch(repo.defaultBranch);
    },
    [repos, sessionTarget]
  );

  const onMultiSelectionChange = useCallback((repoFullNames: string[]) => {
    setSessionTarget({ kind: "repos", repoFullNames });
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
    sessionTarget?.kind === "environment"
      ? environments.find((environment) => environment.id === sessionTarget.environmentId)
      : undefined;
  const displayTargetName = (() => {
    switch (sessionTarget?.kind) {
      case "none":
        return NO_REPOSITORY_LABEL;
      case "repo":
        return selectedRepo?.name ?? sessionTarget.repoFullName;
      case "environment":
        return selectedEnvironment?.name ?? "Environment";
      case "repos": {
        const count = sessionTarget.repoFullNames.length;
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
      description: `${repo.owner}${repo.private ? " • private" : ""}`,
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
              description: describeEnvironment(environment, imageStatusByEnvironment),
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
    isLaunchable: isSessionTargetLaunchable(sessionTarget),
    configKey: getTargetConfigKey(sessionTarget),
    buildRequestFields,
    pickerProps: {
      sessionTarget,
      targetSelectValue: getTargetSelectValue(sessionTarget),
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
    },
  };
}
