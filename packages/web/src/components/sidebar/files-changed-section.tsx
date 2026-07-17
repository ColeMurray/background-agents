"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionDiffFile, SessionDiffRepository } from "@open-inspect/shared";
import { buildUniquePathLabels, type DiffSelection } from "@/lib/session-diffs";
import { cn } from "@/lib/utils";

interface FilesChangedSectionProps {
  repositories: SessionDiffRepository[];
  selected?: DiffSelection | null;
  onSelect: (repository: SessionDiffRepository, file: SessionDiffFile) => void;
}

const STATUS_LABELS: Record<SessionDiffFile["status"], string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  type_changed: "T",
  unmerged: "U",
  submodule: "S",
};

const STATUS_NAMES: Record<SessionDiffFile["status"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  type_changed: "type changed",
  unmerged: "unmerged",
  submodule: "submodule",
};

function fileSummary(file: SessionDiffFile): string {
  if (file.renderState === "binary") return "binary";
  if (file.renderState === "too_large") return "too large";
  if (file.renderState === "metadata_only") return "metadata";
  return `+${file.additions ?? 0} -${file.deletions ?? 0}`;
}

function RepositoryGroup({
  label,
  forceOpen,
  children,
}: {
  label: string;
  forceOpen: boolean;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (forceOpen) setOpen(true);
  }, [forceOpen]);
  return (
    <details open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary className="mb-1.5 cursor-pointer truncate text-[11px] font-medium text-muted-foreground">
        {label}
      </summary>
      <div className="pl-1">{children}</div>
    </details>
  );
}

export function FilesChangedSection({
  repositories,
  selected,
  onSelect,
}: FilesChangedSectionProps) {
  const [query, setQuery] = useState("");
  const paths = useMemo(
    () => repositories.flatMap((repository) => repository.files.map((file) => file.path)),
    [repositories]
  );
  const labels = useMemo(() => buildUniquePathLabels(paths), [paths]);
  const normalizedQuery = query.trim().toLowerCase();
  const fileCount = paths.length;
  if (fileCount === 0) return null;

  return (
    <div className="space-y-3">
      <input
        type="search"
        aria-label="Filter changed files"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder={`Filter ${fileCount} changed file${fileCount === 1 ? "" : "s"}`}
        className="h-8 w-full rounded-md border border-border-muted bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <div className="space-y-3">
        {repositories.map((repository) => {
          const files = repository.files.filter((file) =>
            normalizedQuery ? file.path.toLowerCase().includes(normalizedQuery) : true
          );
          if (files.length === 0) return null;
          const key = `${repository.position}:${repository.repoOwner}/${repository.repoName}`;
          const contents = (
            <>
              <div className="space-y-1">
                {files.map((file) => {
                  const summary = fileSummary(file);
                  const active =
                    selected?.repositoryPosition === repository.position &&
                    selected.path === file.path;
                  return (
                    <button
                      type="button"
                      key={file.id}
                      title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}
                      aria-label={`${labels[file.path]} ${STATUS_NAMES[file.status]} ${summary}`}
                      aria-current={active ? "true" : undefined}
                      data-diff-repository-position={repository.position}
                      data-diff-path={file.path}
                      onClick={() => onSelect(repository, file)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active ? "bg-accent/15 text-foreground" : "text-foreground hover:bg-muted"
                      )}
                    >
                      <span
                        className="w-3 shrink-0 font-mono text-[10px] font-semibold text-muted-foreground"
                        aria-hidden="true"
                      >
                        {STATUS_LABELS[file.status]}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{labels[file.path]}</span>
                      {file.renderState === "renderable" ? (
                        <span className="flex shrink-0 gap-1 font-mono text-[10px]">
                          <span className="text-success">+{file.additions ?? 0}</span>
                          <span className="text-destructive">-{file.deletions ?? 0}</span>
                        </span>
                      ) : (
                        <span className="shrink-0 text-[10px] text-muted-foreground">
                          {summary}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
              {repository.truncated && (
                <p className="mt-2 text-[11px] text-warning">
                  {repository.omittedFileCount} additional files omitted
                </p>
              )}
            </>
          );
          return repositories.length > 1 ? (
            <RepositoryGroup
              key={key}
              label={`${repository.repoOwner}/${repository.repoName}`}
              forceOpen={Boolean(normalizedQuery)}
            >
              {contents}
            </RepositoryGroup>
          ) : (
            <div key={key}>{contents}</div>
          );
        })}
      </div>
    </div>
  );
}
