"use client";

import { useMemo, useState } from "react";
import { MAX_AUTOMATION_REPOSITORIES, type Environment } from "@open-inspect/shared";
import type { Repo } from "@/hooks/use-repos";
import { useBranches } from "@/hooks/use-branches";
import { NO_REPOSITORY_LABEL } from "@/lib/repo-label";
import { Combobox } from "@/components/ui/combobox";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { BoxIcon, BranchIcon, ChevronDownIcon, RepoIcon } from "@/components/ui/icons";
import { FieldDescription } from "./automation-form-field";
import { AutomationTargetPickerMenu } from "./automation-target-picker-menu";
import type { UseAutomationTargetsResult } from "./use-automation-targets";

interface AutomationTargetPickerProps {
  targets: UseAutomationTargetsResult;
  repos: Repo[];
  environments: Environment[];
  loadingRepos: boolean;
  loadingEnvironments: boolean;
  multiTargetAllowed: boolean;
  repositoryRequired: boolean;
}

function getTargetLabel({
  repos,
  environments,
  selectedRepoNames,
  selectedEnvironmentIds,
  loadingEnvironments,
}: {
  repos: Repo[];
  environments: Environment[];
  selectedRepoNames: string[];
  selectedEnvironmentIds: string[];
  loadingEnvironments: boolean;
}) {
  if (selectedRepoNames.length === 0 && selectedEnvironmentIds.length === 0) {
    return NO_REPOSITORY_LABEL;
  }
  if (selectedRepoNames.length === 1 && selectedEnvironmentIds.length === 0) {
    const selectedRepoName = selectedRepoNames[0];
    return (
      repos.find((repo) => repo.fullName.toLowerCase() === selectedRepoName)?.fullName ??
      selectedRepoName
    );
  }
  if (selectedEnvironmentIds.length === 1 && selectedRepoNames.length === 0) {
    const environmentId = selectedEnvironmentIds[0];
    return (
      environments.find((environment) => environment.id === environmentId)?.name ??
      (loadingEnvironments ? "Loading..." : environmentId)
    );
  }

  const parts = [];
  if (selectedRepoNames.length > 0) {
    parts.push(
      selectedRepoNames.length === 1 ? "1 repository" : `${selectedRepoNames.length} repositories`
    );
  }
  if (selectedEnvironmentIds.length > 0) {
    parts.push(
      selectedEnvironmentIds.length === 1
        ? "1 environment"
        : `${selectedEnvironmentIds.length} environments`
    );
  }
  return parts.join(" + ");
}

function getSelectionDescription({
  repositoryRequired,
  multipleSelectionEnabled,
}: {
  repositoryRequired: boolean;
  multipleSelectionEnabled: boolean;
}) {
  if (repositoryRequired) return "Repository-scoped triggers need exactly one repository.";
  if (multipleSelectionEnabled) {
    return `Select up to ${MAX_AUTOMATION_REPOSITORIES} repositories and environments combined. Each firing works every selected repository in its own session and opens one session per selected environment's full workspace.`;
  }
  return "Select no repository, one repository, or one environment.";
}

export function AutomationTargetPicker({
  targets,
  repos,
  environments,
  loadingRepos,
  loadingEnvironments,
  multiTargetAllowed,
  repositoryRequired,
}: AutomationTargetPickerProps) {
  const {
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
  } = targets;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const { branches, loading: loadingBranches } = useBranches(
    selectedRepository?.repoOwner ?? "",
    selectedRepository?.repoName ?? ""
  );
  const normalizedQuery = query.trim().toLowerCase();

  const filteredRepos = useMemo(
    () =>
      normalizedQuery
        ? repos.filter(
            (repo) =>
              repo.fullName.toLowerCase().includes(normalizedQuery) ||
              repo.name.toLowerCase().includes(normalizedQuery) ||
              repo.owner.toLowerCase().includes(normalizedQuery)
          )
        : repos,
    [normalizedQuery, repos]
  );

  const filteredEnvironments = useMemo(() => {
    if (repositoryRequired) return [];
    if (!normalizedQuery) return environments;
    return environments.filter((environment) =>
      environment.name.toLowerCase().includes(normalizedQuery)
    );
  }, [environments, normalizedQuery, repositoryRequired]);

  const label = getTargetLabel({
    repos,
    environments,
    selectedRepoNames,
    selectedEnvironmentIds,
    loadingEnvironments,
  });
  const description = getSelectionDescription({
    repositoryRequired,
    multipleSelectionEnabled,
  });

  const closeAfterSingleSelection = () => {
    if (!multipleSelectionEnabled) setOpen(false);
  };

  return (
    <>
      <div>
        <label className="block text-sm font-medium text-foreground mb-1.5">
          Repository Configuration
        </label>
        <Popover
          open={open}
          onOpenChange={(nextOpen) => {
            setOpen(nextOpen);
            if (!nextOpen) setQuery("");
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              className="flex w-full items-center gap-2 rounded-sm border border-border bg-input px-3 py-2 text-sm text-foreground transition hover:border-foreground/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              aria-label="Repository selection"
            >
              {selectedEnvironmentIds.length > 0 && selectedRepoNames.length === 0 ? (
                <BoxIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              ) : (
                <RepoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
              )}
              <span className="min-w-0 flex-1 truncate text-left">
                {loadingRepos && targetCount === 0 ? "Loading..." : label}
              </span>
              {multipleSelectionEnabled && targetCount > 1 && (
                <span className="shrink-0 text-xs text-muted-foreground">
                  {targetCount}/{MAX_AUTOMATION_REPOSITORIES}
                </span>
              )}
              <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            className="w-[min(34rem,calc(100vw-2rem))] p-0 sm:w-[var(--radix-popover-trigger-width)]"
          >
            <AutomationTargetPickerMenu
              query={query}
              onQueryChange={setQuery}
              repos={filteredRepos}
              environments={filteredEnvironments}
              selectedRepoNames={selectedRepoNames}
              selectedEnvironmentIds={selectedEnvironmentIds}
              targetCount={targetCount}
              loadingRepos={loadingRepos}
              multipleSelectionEnabled={multipleSelectionEnabled}
              multiTargetAllowed={multiTargetAllowed}
              repositoryRequired={repositoryRequired}
              onRepositoryToggle={(repoFullName) => {
                toggleRepository(repoFullName);
                closeAfterSingleSelection();
              }}
              onEnvironmentToggle={(environmentId) => {
                toggleEnvironment(environmentId);
                closeAfterSingleSelection();
              }}
              onClearTargets={() => {
                clearTargets();
                if (!repositoryRequired) setOpen(false);
              }}
              onToggleSelectionMode={toggleSelectionMode}
            />
          </PopoverContent>
        </Popover>
        <FieldDescription>{description}</FieldDescription>
      </div>

      {usesSingleRepository && (
        <div>
          <label className="block text-sm font-medium text-foreground mb-1.5">Branch</label>
          <Combobox
            value={baseBranch}
            onChange={setBaseBranch}
            items={branches.map((branch) => ({
              value: branch.name,
              label: branch.name,
            }))}
            searchable
            searchPlaceholder="Search branches..."
            filterFn={(option, branchQuery) => option.label.toLowerCase().includes(branchQuery)}
            dropdownWidth="w-56"
            disabled={!selectedRepository || loadingBranches}
            triggerClassName="flex w-full items-center gap-1.5 px-3 py-2 text-sm border border-border bg-input text-foreground hover:border-foreground/20 transition"
          >
            <BranchIcon className="w-3.5 h-3.5 text-muted-foreground" />
            <span className="truncate flex-1 text-left">
              {loadingBranches ? "Loading..." : baseBranch || "Select branch"}
            </span>
            <ChevronDownIcon className="w-3 h-3 text-muted-foreground" />
          </Combobox>
          <FieldDescription>
            Default branch checked out when a session run starts. Selecting a repository resets this
            to that repo&apos;s default branch. To filter pull requests by merge target, add a
            Target branch condition below; Head branch matches the PR source branch.
          </FieldDescription>
        </div>
      )}
    </>
  );
}
