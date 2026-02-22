"use client";

import { formatDiffStat, formatFilePath } from "@/lib/format";
import type { GitChangedFile } from "@/types/session";

interface SessionGitFileListProps {
  files: GitChangedFile[];
  selectedFile: string | null;
  onSelectFile: (filename: string) => void;
}

const STATUS_LABELS: Record<GitChangedFile["status"], string> = {
  modified: "M",
  added: "A",
  deleted: "D",
  renamed: "R",
  untracked: "U",
};

export function SessionGitFileList({ files, selectedFile, onSelectFile }: SessionGitFileListProps) {
  if (files.length === 0) {
    return <p className="text-sm text-muted-foreground px-3 py-2">No changed files.</p>;
  }

  return (
    <div className="h-full min-h-0 overflow-y-auto overscroll-contain">
      {files.map((file) => {
        const { display, full } = formatFilePath(file.filename);
        const stat = formatDiffStat(file.additions, file.deletions);
        const isSelected = selectedFile === file.filename;

        return (
          <button
            key={file.filename}
            type="button"
            onClick={() => onSelectFile(file.filename)}
            className={`w-full text-left px-3 py-2 border-b border-border-muted transition ${
              isSelected ? "bg-muted" : "hover:bg-muted/60"
            }`}
            title={full}
          >
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground w-4">
                {STATUS_LABELS[file.status]}
              </span>
              <span className="text-sm text-foreground truncate flex-1">{display}</span>
              <span className="text-xs font-mono text-success">{stat.additions}</span>
              <span className="text-xs font-mono text-destructive">{stat.deletions}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}
