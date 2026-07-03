"use client";

import Link from "next/link";
import { useState } from "react";
import type { AutomationInvocation, AutomationRun } from "@open-inspect/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, ChevronRightIcon } from "@/components/ui/icons";
import { formatRepoLabel } from "@/lib/repo-label";

// The UI keeps "run" vocabulary while the API speaks invocations: each history
// row is one invocation (a single firing). A firing with one repository renders
// exactly like the flat rows always did; a fan-out firing expands into one
// repository row per child run.

function statusBadge(status: AutomationInvocation["status"] | AutomationRun["status"]) {
  switch (status) {
    case "starting":
      return <Badge className="bg-muted text-muted-foreground">Starting</Badge>;
    case "running":
      return <Badge variant="info">Running</Badge>;
    case "completed":
      return <Badge className="bg-success-muted text-success">Completed</Badge>;
    case "failed":
      return <Badge className="bg-destructive-muted text-destructive">Failed</Badge>;
    case "partial_failed":
      return <Badge className="bg-warning-muted text-warning">Partial failure</Badge>;
    case "skipped":
      return <Badge className="bg-warning-muted text-warning">Skipped</Badge>;
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

function formatSkipReason(reason: string): string {
  if (reason === "concurrent_run_active") return "Skipped because a previous run is still active";
  return reason;
}

function formatRunCounts(runs: AutomationRun[]): string {
  const count = (status: AutomationRun["status"]) =>
    runs.filter((run) => run.status === status).length;
  const active = count("starting") + count("running");
  const parts = [`${count("completed")} completed`];
  if (count("failed") > 0) parts.push(`${count("failed")} failed`);
  if (count("skipped") > 0) parts.push(`${count("skipped")} skipped`);
  if (active > 0) parts.push(`${active} running`);
  return parts.join(", ");
}

/** When the firing started doing work: the earliest child launch. */
function invocationStartedAt(invocation: AutomationInvocation): number | null {
  const startTimes = invocation.runs
    .map((run) => run.startedAt)
    .filter((startedAt): startedAt is number => startedAt !== null);
  return startTimes.length > 0 ? Math.min(...startTimes) : null;
}

function firedAtLabel(invocation: AutomationInvocation): string {
  return new Date(invocation.scheduledAt ?? invocation.createdAt).toLocaleString();
}

/** A skipped firing: no child runs, only a reason. */
function SkippedInvocationRow({ invocation }: { invocation: AutomationInvocation }) {
  return (
    <div className="px-4 py-3">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-2 min-w-0">{statusBadge(invocation.status)}</div>
        <span className="text-xs text-muted-foreground flex-shrink-0">
          {firedAtLabel(invocation)}
        </span>
      </div>
      {invocation.skipReason && (
        <p className="mt-1 text-xs text-warning">{formatSkipReason(invocation.skipReason)}</p>
      )}
    </div>
  );
}

/** A firing with one repository — today's single-row rendering, unchanged. */
function SingleRunRow({ invocation }: { invocation: AutomationInvocation }) {
  const run = invocation.runs[0];
  const duration = formatDuration(run.startedAt, run.completedAt);
  return (
    <div className="px-4 py-3">
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
          <span className="text-xs text-muted-foreground">{firedAtLabel(invocation)}</span>
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
      {run.failureReason && <p className="mt-1 text-xs text-destructive">{run.failureReason}</p>}
      {!run.failureReason && run.skipReason && (
        <p className="mt-1 text-xs text-warning">{formatSkipReason(run.skipReason)}</p>
      )}
    </div>
  );
}

/** One repository's outcome inside an expanded fan-out firing. */
function RepositoryRunRow({ run }: { run: AutomationRun }) {
  const duration = formatDuration(run.startedAt, run.completedAt);
  const repoLabel = formatRepoLabel(run.repoOwner, run.repoName);
  return (
    <div className="flex items-start justify-between gap-4 rounded-sm px-2 py-2 transition-colors hover:bg-muted">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {statusBadge(run.status)}
          <span className="text-sm font-medium text-foreground truncate">{repoLabel}</span>
          {run.baseBranch && (
            <span className="text-xs text-muted-foreground">{run.baseBranch}</span>
          )}
          {duration && <span className="text-xs text-muted-foreground">{duration}</span>}
        </div>
        {run.sessionTitle && (
          <p className="mt-1 text-xs text-muted-foreground truncate">{run.sessionTitle}</p>
        )}
        {run.artifactSummary && (
          <p className="mt-1 text-xs text-muted-foreground">{run.artifactSummary}</p>
        )}
        {run.failureReason && <p className="mt-1 text-xs text-destructive">{run.failureReason}</p>}
        {!run.failureReason && run.skipReason && (
          <p className="mt-1 text-xs text-warning">{formatSkipReason(run.skipReason)}</p>
        )}
      </div>
      {run.sessionId && (
        <Link
          href={`/session/${run.sessionId}`}
          aria-label={`View session for ${repoLabel}`}
          className="text-xs text-accent hover:underline flex-shrink-0 mt-0.5"
        >
          View session
        </Link>
      )}
    </div>
  );
}

/** A fan-out firing: a collapsible row summarizing its repository runs. */
function FanOutInvocationRow({
  invocation,
  expanded,
  onToggle,
}: {
  invocation: AutomationInvocation;
  expanded: boolean;
  onToggle: () => void;
}) {
  const duration = formatDuration(invocationStartedAt(invocation), invocation.completedAt);
  return (
    <div className="px-4 py-3">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-4 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 min-w-0">
          {expanded ? (
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )}
          {statusBadge(invocation.status)}
          <span className="text-sm font-medium text-foreground">
            {invocation.runs.length} repositories
          </span>
          <span className="text-xs text-muted-foreground">{formatRunCounts(invocation.runs)}</span>
          {duration && <span className="text-xs text-muted-foreground">{duration}</span>}
        </div>
        <span className="text-xs text-muted-foreground flex-shrink-0">
          {firedAtLabel(invocation)}
        </span>
      </button>
      {expanded && (
        <div className="mt-3 space-y-1 border-t border-border-muted pt-3">
          {invocation.runs.map((run) => (
            <RepositoryRunRow key={run.id} run={run} />
          ))}
        </div>
      )}
    </div>
  );
}

interface RunHistoryProps {
  invocations: AutomationInvocation[];
  total: number;
  loading: boolean;
  onLoadMore?: () => void;
  hasMore: boolean;
}

export function RunHistory({ invocations, total, loading, onLoadMore, hasMore }: RunHistoryProps) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (!loading && invocations.length === 0) {
    return (
      <div className="border border-border-muted rounded-md bg-card p-6 text-center">
        <p className="text-sm text-muted-foreground">No runs yet.</p>
      </div>
    );
  }

  return (
    <div>
      <div className="border border-border-muted rounded-md bg-card divide-y divide-border-muted">
        {invocations.map((invocation) => {
          if (invocation.runs.length > 1) {
            return (
              <FanOutInvocationRow
                key={invocation.id}
                invocation={invocation}
                expanded={expandedIds.has(invocation.id)}
                onToggle={() =>
                  setExpandedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(invocation.id)) next.delete(invocation.id);
                    else next.add(invocation.id);
                    return next;
                  })
                }
              />
            );
          }
          if (invocation.runs.length === 1) {
            return <SingleRunRow key={invocation.id} invocation={invocation} />;
          }
          return <SkippedInvocationRow key={invocation.id} invocation={invocation} />;
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
            Load more ({invocations.length} of {total})
          </Button>
        </div>
      )}
    </div>
  );
}
