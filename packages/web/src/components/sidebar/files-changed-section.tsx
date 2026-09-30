"use client";

import { useMemo, useState } from "react";
import type {
  SessionDiffFile,
  SessionDiffRepository,
} from "@open-inspect/shared/types/session-diffs";
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

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function directoryName(path: string): string {
  return path.slice(0, path.lastIndexOf("/"));
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
  return (
    <details
      open={forceOpen || open}
      onToggle={(event) => {
        if (!forceOpen) setOpen(event.currentTarget.open);
      }}
    >
      <summary
        title={label}
        className="mb-1.5 cursor-pointer text-[11px] font-medium text-muted-foreground [overflow-wrap:anywhere]"
      >
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
  if (fileCount === 0 && repositories.every((repository) => repository.status === "ready")) {
    return null;
  }

  return (
    <div className="space-y-3">
      {fileCount > 0 && (
        <input
          type="search"
          aria-label="Filter changed files"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={`Filter ${fileCount} changed file${fileCount === 1 ? "" : "s"}`}
          className="h-8 w-full rounded-md border border-border-muted bg-background px-2.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      )}
      {normalizedQuery && !paths.some((path) => path.toLowerCase().includes(normalizedQuery)) && (
        <p role="status" className="px-1 text-xs leading-relaxed text-muted-foreground">
          No changed files match “{query}”.
        </p>
      )}
      <div className="space-y-3">
        {repositories.map((repository) => {
          const key = `${repository.position}:${repository.repoOwner}/${repository.repoName}`;
          if (repository.status === "unavailable") {
            const contents = <p className="text-[11px] text-warning">{repository.error}</p>;
            return repositories.length > 1 ? (
              <RepositoryGroup
                key={key}
                label={`${repository.repoOwner}/${repository.repoName}`}
                forceOpen
              >
                {contents}
              </RepositoryGroup>
            ) : (
              <div key={key}>{contents}</div>
            );
          }
          const files = repository.files.filter((file) =>
            normalizedQuery ? file.path.toLowerCase().includes(normalizedQuery) : true
          );
          if (files.length === 0) return null;
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
                        "flex w-full items-center gap-2 rounded-sm border-l-2 px-2 py-2 text-left text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        active
                          ? "border-accent bg-accent-muted text-foreground"
                          : "border-transparent text-foreground hover:bg-muted"
                      )}
                    >
                      <span
                        className={cn(
                          "w-3 shrink-0 font-mono text-[10px] font-semibold",
                          file.status === "added"
                            ? "text-success"
                            : file.status === "deleted"
                              ? "text-destructive"
                              : "text-accent"
                        )}
                        aria-hidden="true"
                      >
                        {STATUS_LABELS[file.status]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{fileName(file.path)}</span>
                        {file.path.includes("/") && (
                          <span className="mt-1 block truncate text-[10px] text-muted-foreground">
                            {directoryName(file.path)}
                          </span>
                        )}
                      </span>
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
