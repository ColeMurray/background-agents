"use client";

import { SessionGitFileList } from "@/components/session-git-file-list";
import { SessionGitDiffViewer } from "@/components/session-git-diff-viewer";
import type { SessionGitChangesResponse } from "@/types/session";

interface SessionGitDiffPanelProps {
  expanded: boolean;
  splitView: boolean;
  selectedFile: string | null;
  loading: boolean;
  error: string | null;
  data: SessionGitChangesResponse | null;
  onToggleExpanded: () => void;
  onToggleSplitView: () => void;
  onSelectFile: (filename: string) => void;
  onRefresh: () => void;
}

export function SessionGitDiffPanel({
  expanded,
  splitView,
  selectedFile,
  loading,
  error,
  data,
  onToggleExpanded,
  onToggleSplitView,
  onSelectFile,
  onRefresh,
}: SessionGitDiffPanelProps) {
  const files = data?.files ?? [];
  const selectedDiff = selectedFile ? (data?.diffsByFile[selectedFile] ?? null) : null;
  const totalFiles = data?.summary.totalFiles ?? 0;

  return (
    <section className="border-t border-border-muted bg-card flex-shrink-0">
      <div className="px-4 py-2 flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={onToggleExpanded}
          className="text-sm text-foreground hover:text-accent transition"
        >
          {expanded ? "Hide changes" : "Show changes"} {totalFiles > 0 ? `(${totalFiles})` : ""}
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleSplitView}
            className="text-xs px-2 py-1 border border-border-muted text-muted-foreground hover:text-foreground transition"
            disabled={!expanded}
          >
            {splitView ? "Unified" : "Split"}
          </button>
          <button
            type="button"
            onClick={onRefresh}
            className="text-xs px-2 py-1 border border-border-muted text-muted-foreground hover:text-foreground transition"
            disabled={loading}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="h-72 border-t border-border-muted flex overflow-hidden">
          <div className="w-80 h-full min-h-0 border-r border-border-muted overflow-hidden">
            {error ? (
              <p className="text-sm text-destructive p-3">{error}</p>
            ) : (
              <SessionGitFileList
                files={files}
                selectedFile={selectedFile}
                onSelectFile={onSelectFile}
              />
            )}
          </div>
          <div className="flex-1 min-w-0 h-full min-h-0 overflow-hidden">
            <SessionGitDiffViewer
              filename={selectedFile}
              rawDiff={selectedDiff}
              splitView={splitView}
            />
          </div>
        </div>
      )}
    </section>
  );
}
