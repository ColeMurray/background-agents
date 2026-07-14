"use client";

import { useEffect, useMemo, useState } from "react";
import { MAX_TARGET_REPOSITORIES, parseRepositoryFullName } from "@open-inspect/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RepoIcon, FolderIcon, SearchIcon, ChevronDownIcon } from "@/components/ui/icons";
import type { Repo } from "@/hooks/use-repos";
import { cn } from "@/lib/utils";

/** Selection key for a repository: the lowercase full name, as the API stores it. */
export function repositorySelectionKey(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`.toLowerCase();
}

/**
 * Ordered multi-select of repositories behind a searchable popover (the
 * automation form's selector pattern) — selection order is list order, so
 * `selected[0]` is the primary. Enforces the session/environment list rules
 * client-side: at most MAX_TARGET_REPOSITORIES entries, and no duplicate
 * repository *name* across owners (checkout paths are /workspace/{repoName}).
 */
export function RepositoryMultiSelect({
  repos,
  loadingRepos,
  selected,
  onChange,
  disabled = false,
  triggerLabel,
  triggerClassName,
}: {
  repos: Repo[];
  loadingRepos: boolean;
  /** Ordered lowercase "owner/name" keys; [0] is the primary. */
  selected: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  triggerLabel: string;
  triggerClassName?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const normalizedQuery = query.trim().toLowerCase();
  const filteredRepos = useMemo(
    () =>
      normalizedQuery
        ? repos.filter((repo) => repo.fullName.toLowerCase().includes(normalizedQuery))
        : repos,
    [repos, normalizedQuery]
  );

  const selectedNamesByKey = useMemo(() => {
    const names = new Map<string, string>();
    for (const key of selected) {
      const name = parseRepositoryFullName(key)?.repoName;
      if (name) names.set(name, key);
    }
    return names;
  }, [selected]);

  const handleToggle = (repo: Repo) => {
    const key = repositorySelectionKey(repo.owner, repo.name);
    if (selected.includes(key)) {
      onChange(selected.filter((entry) => entry !== key));
      return;
    }
    if (selected.length >= MAX_TARGET_REPOSITORIES) return;
    onChange([...selected, key]);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            "flex items-center gap-2 rounded-sm border border-border bg-input px-3 py-2 text-sm text-foreground transition hover:border-foreground/20 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50",
            triggerClassName
          )}
          aria-label="Repository selection"
        >
          <RepoIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-left">
            {loadingRepos && selected.length === 0 ? "Loading..." : triggerLabel}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {selected.length}/{MAX_TARGET_REPOSITORIES}
          </span>
          <ChevronDownIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(34rem,calc(100vw-2rem))] p-0 sm:w-[var(--radix-popover-trigger-width)]"
      >
        <div className="border-b border-border-muted p-2">
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={loadingRepos ? "Loading repositories..." : "Search repositories"}
              disabled={loadingRepos}
              autoFocus
              className="pl-8"
            />
          </div>
        </div>
        <div className="max-h-72 overflow-y-auto py-1">
          {filteredRepos.map((repo) => {
            const key = repositorySelectionKey(repo.owner, repo.name);
            const checked = selected.includes(key);
            const atCap = !checked && selected.length >= MAX_TARGET_REPOSITORIES;
            const nameCollision =
              !checked && selectedNamesByKey.get(repo.name.toLowerCase()) !== undefined;
            const itemDisabled = atCap || nameCollision;

            return (
              <label
                key={repo.fullName}
                title={
                  nameCollision
                    ? `Another selected repository is also named "${repo.name}" — checkout paths would collide`
                    : undefined
                }
                className={cn(
                  "flex min-h-10 w-full items-center gap-2 px-3 py-2 text-left text-sm transition",
                  checked ? "bg-muted text-foreground" : "hover:bg-muted/60",
                  itemDisabled && "cursor-not-allowed opacity-50"
                )}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={itemDisabled}
                  onChange={() => handleToggle(repo)}
                  className="h-4 w-4 rounded border-border accent-accent"
                />
                <FolderIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">
                  {repo.owner}/{repo.name}
                </span>
                {repo.private && <span className="text-xs text-muted-foreground">private</span>}
              </label>
            );
          })}
          {filteredRepos.length === 0 && (
            <div className="px-3 py-3 text-sm text-muted-foreground">No repositories found</div>
          )}
        </div>
        <div className="flex justify-end border-t border-border-muted px-3 py-2">
          <Button type="button" variant="outline" size="xs" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
