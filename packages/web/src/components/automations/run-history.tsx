"use client";

import Link from "next/link";
import { useState } from "react";
import type { AutomationRun, AutomationRunGroup } from "@open-inspect/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icons";

const STATUS_BADGES = {
  starting: <Badge className="bg-muted text-muted-foreground">Starting</Badge>,
  running: <Badge variant="info">Running</Badge>,
  completed: <Badge className="bg-success-muted text-success">Completed</Badge>,
  failed: <Badge className="bg-destructive-muted text-destructive">Failed</Badge>,
  partial_failed: <Badge className="bg-warning-muted text-warning">Partial failure</Badge>,
  skipped: <Badge className="bg-warning-muted text-warning">Skipped</Badge>,
};

function statusBadge(status: AutomationRun["status"] | AutomationRunGroup["status"]) {
  return STATUS_BADGES[status];
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
  groups?: AutomationRunGroup[];
  total: number;
  loading: boolean;
  onLoadMore?: () => void;
  hasMore: boolean;
}

export function RunHistory({
  runs,
  groups = [],
  total,
  loading,
  onLoadMore,
  hasMore,
}: RunHistoryProps) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const hasGroups = groups.length > 0;
  const displayedRuns = hasGroups ? [] : runs;

  if (!loading && displayedRuns.length === 0 && groups.length === 0) {
    return (
      <div className="border border-border-muted rounded-md bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="border border-border-muted rounded-md bg-card divide-y divide-border-muted">
        {groups.map((group) => {
          const expanded = expandedGroups.has(group.id);
          const duration = formatDuration(group.startedAt, group.completedAt);
          const hasChildRuns = group.totalRuns > 0;
          const groupSummary = group.failureReason ?? group.skipReason;
          return (
            <div key={group.id} className="px-4 py-3">
              <button
                type="button"
                className="flex w-full items-center justify-between gap-4 text-left"
                disabled={!hasChildRuns}
                onClick={() =>
                  setExpandedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  })
                }
              >
                <div className="flex min-w-0 items-center gap-2">
                  {!hasChildRuns ? (
                    <span className="h-3.5 w-3.5" />
                  ) : expanded ? (
                    <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  {statusBadge(group.status)}
                  {hasChildRuns ? (
                    <>
                      <span className="text-sm text-foreground">
                        {group.totalRuns} {group.totalRuns === 1 ? "repository" : "repositories"}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {group.completedRuns} completed
                        {group.failedRuns > 0 ? `, ${group.failedRuns} failed` : ""}
                        {group.runningRuns + group.startingRuns > 0
                          ? `, ${group.runningRuns + group.startingRuns} running`
                          : ""}
                      </span>
                    </>
                  ) : (
                    <span className="text-sm text-muted-foreground">
                      {groupSummary ?? "No repository sessions started"}
                    </span>
                  )}
                  {duration && <span className="text-xs text-muted-foreground">{duration}</span>}
                </div>
                <span className="flex-shrink-0 text-xs text-muted-foreground">
                  {new Date(group.scheduledAt).toLocaleString()}
                </span>
              </button>
              {expanded && hasChildRuns && (
                <div className="mt-3 space-y-2 border-l border-border-muted pl-5">
                  {group.runs.map((run) => {
                    const childDuration = formatDuration(run.startedAt, run.completedAt);
                    const target =
                      run.targetRepoOwner && run.targetRepoName
                        ? `${run.targetRepoOwner}/${run.targetRepoName}`
                        : run.sessionTitle;
                    return (
                      <div key={run.id} className="flex items-center justify-between gap-3 text-sm">
                        <div className="flex min-w-0 items-center gap-2">
                          {statusBadge(run.status)}
                          <span className="truncate text-foreground">{target}</span>
                          {childDuration && (
                            <span className="text-xs text-muted-foreground">{childDuration}</span>
                          )}
                        </div>
                        {run.sessionId && (
                          <Link
                            href={`/session/${run.sessionId}`}
                            className="flex-shrink-0 text-xs text-accent hover:underline"
                          >
                            View session
                          </Link>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {hasChildRuns && group.failureReason && (
                <p className="mt-1 text-xs text-destructive">{group.failureReason}</p>
              )}
              {hasChildRuns && !group.failureReason && group.skipReason && (
                <p className="mt-1 text-xs text-warning">{group.skipReason}</p>
              )}
            </div>
          );
        })}
        {displayedRuns.map((run) => {
          const duration = formatDuration(run.startedAt, run.completedAt);
          return (
            <div key={run.id} className="px-4 py-3">
              <div className="flex items-center justify-between gap-4">
                <div className="flex items-center gap-2 min-w-0">
                  {statusBadge(run.status)}
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
                <p className="mt-1 text-xs text-destructive">{run.failureReason}</p>
              )}
              {!run.failureReason && run.skipReason && (
                <p className="mt-1 text-xs text-warning">{run.skipReason}</p>
              )}
            </div>
          );
        })}
      </div>

      {loading && (
        <div className="flex justify-center py-4">
          <div className="animate-spin rounded-full h-6 w-6 border-2 border-current border-t-transparent text-muted-foreground" />
        </div>
      )}

      {hasMore && !loading && onLoadMore && (
        <div className="mt-3 text-center">
          <Button variant="ghost" size="sm" onClick={onLoadMore}>
            Load more ({hasGroups ? groups.length : displayedRuns.length} of {total})
          </Button>
        </div>
      )}
    </div>
  );
}
