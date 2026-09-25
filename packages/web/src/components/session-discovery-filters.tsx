"use client";

import { useId, type ReactNode } from "react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { formatRepoLabel } from "@/lib/repo-label";
import {
  SESSION_LIFECYCLE_LABELS,
  SESSION_LIFECYCLES,
  SESSION_ORIGIN_LABELS,
  SESSION_ORIGINS,
  type SessionCreatorFilter,
  type SessionDiscoveryQuery,
  type SessionRepositoryFilter,
} from "@/lib/session-discovery";

/** Radix Select reserves the empty string, so "Any" options use a sentinel value. */
const ANY_OPTION = "__any__";
/**
 * Environment IDs come from the URL unvalidated, so their option values are
 * namespaced to keep an `environmentId` from colliding with `ANY_OPTION`.
 */
const ENVIRONMENT_OPTION_PREFIX = "environment:";

interface LabeledSelectProps {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  triggerClassName?: string;
  children: ReactNode;
}

/** The app's Select with a visible label, sized to sit in the filter row. */
function LabeledSelect({
  label,
  value,
  onValueChange,
  triggerClassName,
  children,
}: LabeledSelectProps) {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <Select value={value} onValueChange={onValueChange}>
        <SelectTrigger id={id} density="compact" className={cn("h-9", triggerClassName)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>{children}</SelectContent>
      </Select>
    </div>
  );
}

function repositoryOptionValue(repository: SessionRepositoryFilter): string {
  return `${repository.repoOwner}/${repository.repoName}`;
}

/** Owners may contain `/` (nested namespaces); the name never does. */
function parseRepositoryOptionValue(value: string): SessionRepositoryFilter | null {
  const separator = value.lastIndexOf("/");
  if (separator <= 0 || separator === value.length - 1) return null;
  return { repoOwner: value.slice(0, separator), repoName: value.slice(separator + 1) };
}

export interface SessionDiscoveryFiltersProps {
  query: SessionDiscoveryQuery;
  repositories: ReadonlyArray<SessionRepositoryFilter>;
  environments: ReadonlyArray<{ id: string; name: string }>;
  hasFilters: boolean;
  onChange: (patch: Partial<SessionDiscoveryQuery>) => void;
  onClear: () => void;
}

/** The URL-backed filter row for the Sessions page. */
export function SessionDiscoveryFilters({
  query,
  repositories,
  environments,
  hasFilters,
  onChange,
  onClear,
}: SessionDiscoveryFiltersProps) {
  // A shared link may name a repository or environment the picker sources do
  // not list (a repository the app lost access to, a deleted environment).
  // Keep the active selection visible so the filter is never silently blank.
  const repositoryOptions = [...repositories];
  if (
    query.repository &&
    !repositories.some(
      (repository) =>
        repository.repoOwner === query.repository?.repoOwner &&
        repository.repoName === query.repository?.repoName
    )
  ) {
    repositoryOptions.unshift(query.repository);
  }
  const environmentOptions = [...environments];
  if (
    query.environmentId &&
    !environments.some((environment) => environment.id === query.environmentId)
  ) {
    environmentOptions.unshift({ id: query.environmentId, name: query.environmentId });
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <div className="flex flex-col gap-1">
        <span
          id="session-creator-filter-label"
          className="text-xs font-medium text-muted-foreground"
        >
          Creator
        </span>
        <ToggleGroup
          type="single"
          value={query.creator}
          onValueChange={(value) => {
            if (value === "all" || value === "mine") {
              onChange({ creator: value as SessionCreatorFilter });
            }
          }}
          aria-labelledby="session-creator-filter-label"
          className="grid h-9 grid-cols-2 rounded-sm border border-border bg-muted p-0.5"
        >
          <ToggleGroupItem
            value="all"
            className="h-full rounded-sm px-3 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            All
          </ToggleGroupItem>
          <ToggleGroupItem
            value="mine"
            className="h-full rounded-sm px-3 text-xs data-[state=on]:bg-background data-[state=on]:text-foreground"
          >
            Mine
          </ToggleGroupItem>
        </ToggleGroup>
      </div>

      <LabeledSelect
        label="Repository"
        value={query.repository ? repositoryOptionValue(query.repository) : ANY_OPTION}
        onValueChange={(value) =>
          onChange({ repository: value === ANY_OPTION ? null : parseRepositoryOptionValue(value) })
        }
        triggerClassName="w-56"
      >
        <SelectItem value={ANY_OPTION}>Any repository</SelectItem>
        {repositoryOptions.map((repository) => {
          const value = repositoryOptionValue(repository);
          return (
            <SelectItem key={value} value={value}>
              {formatRepoLabel(repository.repoOwner, repository.repoName)}
            </SelectItem>
          );
        })}
      </LabeledSelect>

      <LabeledSelect
        label="Environment"
        value={
          query.environmentId ? `${ENVIRONMENT_OPTION_PREFIX}${query.environmentId}` : ANY_OPTION
        }
        onValueChange={(value) =>
          onChange({
            environmentId: value.startsWith(ENVIRONMENT_OPTION_PREFIX)
              ? value.slice(ENVIRONMENT_OPTION_PREFIX.length)
              : null,
          })
        }
        triggerClassName="w-44"
      >
        <SelectItem value={ANY_OPTION}>Any environment</SelectItem>
        {environmentOptions.map((environment) => (
          <SelectItem key={environment.id} value={`${ENVIRONMENT_OPTION_PREFIX}${environment.id}`}>
            {environment.name}
          </SelectItem>
        ))}
      </LabeledSelect>

      <LabeledSelect
        label="Lifecycle"
        value={query.lifecycle}
        onValueChange={(value) => {
          if (SESSION_LIFECYCLES.includes(value as SessionDiscoveryQuery["lifecycle"])) {
            onChange({ lifecycle: value as SessionDiscoveryQuery["lifecycle"] });
          }
        }}
        triggerClassName="w-36"
      >
        {SESSION_LIFECYCLES.map((lifecycle) => (
          <SelectItem key={lifecycle} value={lifecycle}>
            {SESSION_LIFECYCLE_LABELS[lifecycle]}
          </SelectItem>
        ))}
      </LabeledSelect>

      <LabeledSelect
        label="Origin"
        value={query.origin ?? ANY_OPTION}
        onValueChange={(value) => {
          if (value === ANY_OPTION) {
            onChange({ origin: null });
          } else if (SESSION_ORIGINS.includes(value as SessionDiscoveryQuery["origin"] & string)) {
            onChange({ origin: value as SessionDiscoveryQuery["origin"] });
          }
        }}
        triggerClassName="w-44"
      >
        <SelectItem value={ANY_OPTION}>Any origin</SelectItem>
        {SESSION_ORIGINS.map((origin) => (
          <SelectItem key={origin} value={origin}>
            {SESSION_ORIGIN_LABELS[origin]}
          </SelectItem>
        ))}
      </LabeledSelect>

      {hasFilters && (
        <Button variant="ghost" size="sm" className="h-9" onClick={onClear}>
          Clear filters
        </Button>
      )}
    </div>
  );
}
