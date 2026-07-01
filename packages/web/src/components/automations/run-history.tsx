"use client";

import Link from "next/link";
import { useState } from "react";
import type { AutomationRun, AutomationRunGroup } from "@open-inspect/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icons";
import { formatRepoLabel } from "@/lib/repo-label";

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

function formatRunCounts(group: AutomationRunGroup): string {
  const activeRuns = group.runningRuns + group.startingRuns;
  const parts = [`${group.completedRuns} completed`];
  if (group.failedRuns > 0) parts.push(`${group.failedRuns} failed`);
  if (group.skippedRuns > 0) parts.push(`${group.skippedRuns} skipped`);
  if (activeRuns > 0) parts.push(`${activeRuns} running`);
  return parts.join(", ");
}

function formatReason(reason: string): string {
  if (reason === "concurrent_run_active") return "Skipped because another run group is active";
  return reason;
}

function formatTarget(run: AutomationRun): string {
  return formatRepoLabel(run.targetRepoOwner, run.targetRepoName);
}

function formatSessionState(run: AutomationRun): string {
  if (run.sessionId) return "Session created";
  if (run.status === "skipped") return "No session needed";
  return "No session yet";
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
          const autoPauseSignal = group.failureCountedAt
            ? `Counts toward auto-pause since ${new Date(group.failureCountedAt).toLocaleString()}`
            : null;
          return (
            <div key={group.id} className="px-4 py-3">
              <button
                type="button"
                className="flex w-full flex-col gap-2 text-left sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                disabled={!hasChildRuns}
                aria-expanded={hasChildRuns ? expanded : undefined}
                onClick={() =>
                  setExpandedGroups((prev) => {
                    const next = new Set(prev);
                    if (next.has(group.id)) next.delete(group.id);
                    else next.add(group.id);
                    return next;
                  })
                }
              >
                <div className="flex min-w-0 flex-1 items-start gap-2">
                  {!hasChildRuns ? (
                    <span className="mt-0.5 h-3.5 w-3.5" />
                  ) : expanded ? (
                    <ChevronDownIcon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRightIcon className="mt-0.5 h-3.5 w-3.5 text-muted-foreground" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {statusBadge(group.status)}
                      {hasChildRuns ? (
                        <>
                          <span className="text-sm font-medium text-foreground">
                            {group.totalRuns}{" "}
                            {group.totalRuns === 1 ? "repository" : "repositories"}
                          </span>
                          <span className="text-xs text-muted-foreground">
                            {formatRunCounts(group)}
                          </span>
                        </>
                      ) : (
                        <span className="text-sm text-muted-foreground">
                          {groupSummary
                            ? formatReason(groupSummary)
                            : "No repository sessions started"}
                        </span>
                      )}
                      {duration && (
                        <span className="text-xs text-muted-foreground">{duration}</span>
                      )}
                    </div>
                  </div>
                </div>
                <span className="text-xs text-muted-foreground sm:flex-shrink-0">
                  {new Date(group.scheduledAt).toLocaleString()}
                </span>
              </button>
              {expanded && hasChildRuns && (
                <div className="mt-3 space-y-3 border-t border-border-muted pt-3">
                  {(group.skipReason || group.failureReason || autoPauseSignal) && (
                    <div className="space-y-1 text-xs">
                      {group.failureReason && (
                        <p className="text-destructive">{group.failureReason}</p>
                      )}
                      {!group.failureReason && group.skipReason && (
                        <p className="text-warning">{formatReason(group.skipReason)}</p>
                      )}
                      {autoPauseSignal && (
                        <p className="text-muted-foreground">{autoPauseSignal}</p>
                      )}
                    </div>
                  )}
                  <div className="space-y-1">
                    {group.runs.map((run) => {
                      const childDuration = formatDuration(run.startedAt, run.completedAt);
                      const target = formatTarget(run);
                      return (
                        <div
                          key={run.id}
                          className="grid gap-2 rounded-sm px-2 py-2 transition-colors hover:bg-muted sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start"
                        >
                          <div className="min-w-0">
                            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm">
                              {statusBadge(run.status)}
                              <span className="min-w-0 truncate font-medium text-foreground">
                                {target}
                              </span>
                              {childDuration && (
                                <span className="text-xs text-muted-foreground">
                                  {childDuration}
                                </span>
                              )}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                              <span>{formatSessionState(run)}</span>
                              {run.targetBaseBranch && (
                                <span>Base branch: {run.targetBaseBranch}</span>
                              )}
                              {run.artifactSummary && <span>{run.artifactSummary}</span>}
                            </div>
                            {run.failureReason && (
                              <p className="mt-1 text-xs text-destructive">{run.failureReason}</p>
                            )}
                            {!run.failureReason && run.skipReason && (
                              <p className="mt-1 text-xs text-warning">
                                {formatReason(run.skipReason)}
                              </p>
                            )}
                          </div>
                          {run.sessionId ? (
                            <Link
                              href={`/session/${run.sessionId}`}
                              aria-label={`View session for ${target}`}
                              className="text-xs text-accent hover:underline sm:mt-0.5"
                            >
                              View session
                            </Link>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
              {hasChildRuns && !expanded && group.failureReason && (
                <p className="mt-1 text-xs text-destructive">{group.failureReason}</p>
              )}
              {hasChildRuns && !expanded && !group.failureReason && group.skipReason && (
                <p className="mt-1 text-xs text-warning">{formatReason(group.skipReason)}</p>
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
