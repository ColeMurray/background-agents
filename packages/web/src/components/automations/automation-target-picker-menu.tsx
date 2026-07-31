"use client";

import type { ReactNode } from "react";
import type { Environment } from "@open-inspect/shared/types/environments";
import { MAX_AUTOMATION_REPOSITORIES } from "@open-inspect/shared/types/automations";
import type { Repo } from "@/hooks/use-repos";
import { formatRepositoriesLabel, NO_REPOSITORY_LABEL } from "@/lib/repo-label";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { BoxIcon, CheckIcon, FolderIcon, RepoIcon, SearchIcon } from "@/components/ui/icons";

interface TargetOptionProps {
  multipleSelectionEnabled: boolean;
  selected: boolean;
  disabled?: boolean;
  icon: ReactNode;
  onSelect: () => void;
  children: ReactNode;
}

function TargetOption({
  multipleSelectionEnabled,
  selected,
  disabled = false,
  icon,
  onSelect,
  children,
}: TargetOptionProps) {
  const className = cn(
    "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
    selected ? "bg-muted text-foreground" : "hover:bg-muted/60",
    disabled && "cursor-not-allowed opacity-50"
  );

  if (multipleSelectionEnabled) {
    return (
      <label className={className}>
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled}
          onChange={onSelect}
          className="h-4 w-4 rounded border-border accent-accent"
        />
        {icon}
        {children}
      </label>
    );
  }

  return (
    <button type="button" disabled={disabled} onClick={onSelect} className={className}>
      {icon}
      {children}
      {selected && <CheckIcon className="h-4 w-4 shrink-0 text-accent" />}
    </button>
  );
}

interface AutomationTargetPickerMenuProps {
  query: string;
  onQueryChange: (query: string) => void;
  repos: Repo[];
  environments: Environment[];
  selectedRepoNames: string[];
  selectedEnvironmentIds: string[];
  targetCount: number;
  loadingRepos: boolean;
  multipleSelectionEnabled: boolean;
  multiTargetAllowed: boolean;
  repositoryRequired: boolean;
  onRepositoryToggle: (repoFullName: string) => void;
  onEnvironmentToggle: (environmentId: string) => void;
  onClearTargets: () => void;
  onToggleSelectionMode: () => void;
}

export function AutomationTargetPickerMenu({
  query,
  onQueryChange,
  repos,
  environments,
  selectedRepoNames,
  selectedEnvironmentIds,
  targetCount,
  loadingRepos,
  multipleSelectionEnabled,
  multiTargetAllowed,
  repositoryRequired,
  onRepositoryToggle,
  onEnvironmentToggle,
  onClearTargets,
  onToggleSelectionMode,
}: AutomationTargetPickerMenuProps) {
  return (
    <>
      <div className="border-b border-border-muted p-2">
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={loadingRepos ? "Loading repositories..." : "Search repositories"}
            disabled={loadingRepos}
            autoFocus
            className="pl-8"
          />
        </div>
      </div>

      {environments.length > 0 && (
        <>
          <div className="border-b border-border-muted px-3 py-2">
            <span className="text-xs font-medium uppercase text-muted-foreground">
              Environments
            </span>
          </div>
          <div className="max-h-40 overflow-y-auto border-b border-border-muted py-1">
            {environments.map((environment) => {
              const selected = selectedEnvironmentIds.includes(environment.id);
              const disabled =
                multipleSelectionEnabled && !selected && targetCount >= MAX_AUTOMATION_REPOSITORIES;

              return (
                <TargetOption
                  key={environment.id}
                  multipleSelectionEnabled={multipleSelectionEnabled}
                  selected={selected}
                  disabled={disabled}
                  icon={<BoxIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
                  onSelect={() => onEnvironmentToggle(environment.id)}
                >
                  <span className="min-w-0 flex-1 truncate">{environment.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {formatRepositoriesLabel(environment.repositories)}
                  </span>
                </TargetOption>
              );
            })}
          </div>
        </>
      )}

      <div className="flex items-center justify-between border-b border-border-muted px-3 py-2">
        <span className="text-xs font-medium uppercase text-muted-foreground">
          All repositories
        </span>
        {multiTargetAllowed && (
          <Button type="button" variant="outline" size="xs" onClick={onToggleSelectionMode}>
            {multipleSelectionEnabled ? "Select One" : "Select Multiple"}
          </Button>
        )}
      </div>

      <div className="max-h-72 overflow-y-auto py-1">
        <TargetOption
          multipleSelectionEnabled={multipleSelectionEnabled}
          selected={targetCount === 0}
          disabled={repositoryRequired}
          icon={<RepoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
          onSelect={onClearTargets}
        >
          <span className="min-w-0 flex-1 truncate">{NO_REPOSITORY_LABEL}</span>
        </TargetOption>

        {repos.map((repo) => {
          const selected = selectedRepoNames.includes(repo.fullName.toLowerCase());
          const disabled =
            multipleSelectionEnabled && !selected && targetCount >= MAX_AUTOMATION_REPOSITORIES;

          return (
            <TargetOption
              key={repo.fullName}
              multipleSelectionEnabled={multipleSelectionEnabled}
              selected={selected}
              disabled={disabled}
              icon={<FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />}
              onSelect={() => onRepositoryToggle(repo.fullName)}
            >
              <span className="min-w-0 flex-1 truncate">
                {repo.owner}/{repo.name}
              </span>
              {repo.private && <span className="text-xs text-muted-foreground">private</span>}
            </TargetOption>
          );
        })}

        {repos.length === 0 && (
          <div className="px-3 py-3 text-sm text-muted-foreground">No repositories found</div>
        )}
      </div>
    </>
  );
}
