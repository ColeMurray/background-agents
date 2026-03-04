"use client";

import Link from "next/link";
import type { AutomationRun } from "@open-inspect/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function runStatusBadge(status: AutomationRun["status"]) {
  switch (status) {
    case "starting":
      return <Badge className="bg-muted text-muted-foreground">Starting</Badge>;
    case "running":
      return <Badge className="bg-blue-500/10 text-blue-600 dark:text-blue-400">Running</Badge>;
    case "completed":
      return <Badge className="bg-success-muted text-success">Completed</Badge>;
    case "failed":
      return (
        <Badge className="bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400">
          Failed
        </Badge>
      );
    case "skipped":
      return (
        <Badge className="bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
          Skipped
        </Badge>
      );
  }
}

function formatDuration(startedAt: number | null, completedAt: number | null): string | null {
  if (!startedAt || !completedAt) return null;
  const durationMs = completedAt - startedAt;
  const seconds = Math.floor(durationMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

interface RunHistoryProps {
  runs: AutomationRun[];
  total: number;
  loading: boolean;
  onLoadMore?: () => void;
  hasMore: boolean;
}

export function RunHistory({ runs, total, loading, onLoadMore, hasMore }: RunHistoryProps) {
  if (!loading && runs.length === 0) {
    return (
      <div className="border border-border-muted rounded-md bg-background p-6 text-center">
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="border border-border-muted rounded-md bg-background divide-y divide-border-muted">
        {runs.map((run) => {
          const duration = formatDuration(run.startedAt, run.completedAt);
          return (
            <div key={run.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  {runStatusBadge(run.status)}
                  {run.sessionTitle && (
                    <span className="text-sm text-foreground truncate">{run.sessionTitle}</span>
                  )}
                  {duration && <span className="text-xs text-muted-foreground">{duration}</span>}
                  {run.artifactSummary && (
                    <span className="text-xs text-muted-foreground">{run.artifactSummary}</span>
                  )}
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs text-muted-foreground">
                    {new Date(run.scheduledAt).toLocaleString()}
                  </span>
                  {run.sessionId && (
                    <Link
                      href={`/session/${run.sessionId}`}
                      className="text-xs text-accent hover:underline"
                    >
                      View session
                    </Link>
                  )}
                </div>
              </div>
              {run.failureReason && (
                <p className="mt-1 text-xs text-red-500">{run.failureReason}</p>
              )}
              {!run.failureReason && run.skipReason && (
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{run.skipReason}</p>
              )}
            </div>
          );
        })}
      </div>

      {loading && (
        <div className="flex justify-center py-4">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-muted-foreground" />
        </div>
      )}

      {hasMore && !loading && onLoadMore && (
        <div className="mt-3 text-center">
          <Button variant="ghost" size="sm" onClick={onLoadMore}>
            Load more ({runs.length} of {total})
          </Button>
        </div>
      )}
    </div>
  );
}
