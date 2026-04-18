import type { AnalyticsBreakdownEntry, AnalyticsBreakdownResponse } from "@open-inspect/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ChevronDownIcon, ChevronUpIcon } from "@/components/ui/icons";
import {
  formatAnalyticsCount,
  formatAnalyticsDuration,
  formatCompletionRate,
  getCompletionRate,
  type AnalyticsSortDirection,
  type AnalyticsUserSortKey,
} from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { formatSessionCost } from "@/lib/session-cost";
import { formatRelativeTime } from "@/lib/time";

interface UserTableProps {
  entries?: AnalyticsBreakdownResponse["entries"];
  loading: boolean;
  sortKey: AnalyticsUserSortKey;
  sortDirection: AnalyticsSortDirection;
  onSort: (key: AnalyticsUserSortKey) => void;
}

function SortButton({
  label,
  sortKey,
  activeKey,
  direction,
  onClick,
  align = "left",
}: {
  label: string;
  sortKey: AnalyticsUserSortKey;
  activeKey: AnalyticsUserSortKey;
  direction: AnalyticsSortDirection;
  onClick: (key: AnalyticsUserSortKey) => void;
  align?: "left" | "right";
}) {
  const isActive = activeKey === sortKey;
  const Icon = direction === "asc" ? ChevronUpIcon : ChevronDownIcon;

  return (
    <Button
      variant="ghost"
      size="xs"
      className={align === "right" ? "ml-auto" : "-ml-2"}
      onClick={() => onClick(sortKey)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {isActive ? <Icon className="h-3 w-3" /> : null}
      </span>
    </Button>
  );
}

function UserCell({ entry }: { entry: AnalyticsBreakdownEntry }) {
  const isUnknown = entry.key === "unknown";
  const label = isUnknown ? "Unknown user" : entry.key;
  const initial = label[0]?.toUpperCase() ?? "?";

  return (
    <div className="flex items-center gap-3">
      <div
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full border text-xs font-semibold",
          isUnknown
            ? "border-border-muted bg-muted text-muted-foreground"
            : "border-border-muted bg-accent-muted text-foreground"
        )}
      >
        {initial}
      </div>
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">{label}</div>
        <div className="text-xs text-muted-foreground">
          {isUnknown ? "Sessions without SCM login" : "Tracked user activity"}
        </div>
      </div>
    </div>
  );
}

function SessionsCell({ entry }: { entry: AnalyticsBreakdownEntry }) {
  return (
    <div className="min-w-[11rem]">
      <div className="font-medium text-foreground">{formatAnalyticsCount(entry.sessions)}</div>
      <div className="mt-2 flex flex-wrap gap-1">
        <Badge variant="pr-merged">{formatAnalyticsCount(entry.completed)} completed</Badge>
        {entry.failed > 0 ? (
          <Badge variant="pr-closed">{formatAnalyticsCount(entry.failed)} failed</Badge>
        ) : null}
        {entry.cancelled > 0 ? (
          <Badge variant="pr-draft">{formatAnalyticsCount(entry.cancelled)} cancelled</Badge>
        ) : null}
      </div>
    </div>
  );
}

function CompletionRateCell({ entry }: { entry: AnalyticsBreakdownEntry }) {
  const ratio = getCompletionRate(entry);
  const width = Math.min(100, Math.max(0, Math.round(ratio * 100)));

  return (
    <div className="ml-auto flex w-24 flex-col items-end">
      <span className="text-foreground">{formatCompletionRate(entry)}</span>
      <div className="mt-2 h-1.5 w-full rounded-full bg-muted">
        <div className="h-full rounded-full bg-accent" style={{ width: `${width}%` }} />
      </div>
    </div>
  );
}

export function AnalyticsUserTable({
  entries,
  loading,
  sortKey,
  sortDirection,
  onSort,
}: UserTableProps) {
  function getAriaSort(column: AnalyticsUserSortKey): "ascending" | "descending" | "none" {
    if (sortKey !== column) {
      return "none";
    }

    return sortDirection === "asc" ? "ascending" : "descending";
  }

  if (loading && !entries) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5 animate-pulse">
        <div className="h-4 w-36 rounded bg-muted" />
        <div className="mt-2 h-4 w-64 rounded bg-muted" />
        <div className="mt-6 h-56 rounded bg-muted" />
      </div>
    );
  }

  if (!entries?.length) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5">
        <div className="text-lg font-semibold text-foreground">Per-User Breakdown</div>
        <p className="mt-1 text-sm text-muted-foreground">
          No user analytics found for this range.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border-muted bg-card">
      <div className="border-b border-border-muted px-5 py-4">
        <h2 className="text-lg font-semibold text-foreground">Per-User Breakdown</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Sortable usage metrics without ranking or gamification.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full border-collapse text-sm">
          <thead className="bg-card">
            <tr className="border-b border-border-muted text-left text-secondary-foreground">
              <th className="px-5 py-3" aria-sort={getAriaSort("user")}>
                <SortButton
                  label="User"
                  sortKey="user"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onClick={onSort}
                />
              </th>
              <th className="px-5 py-3" aria-sort={getAriaSort("sessions")}>
                <SortButton
                  label="Sessions"
                  sortKey="sessions"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onClick={onSort}
                />
              </th>
              <th className="px-5 py-3 text-right" aria-sort={getAriaSort("completionRate")}>
                <SortButton
                  label="Completion Rate"
                  sortKey="completionRate"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onClick={onSort}
                  align="right"
                />
              </th>
              <th className="px-5 py-3 text-right" aria-sort={getAriaSort("prs")}>
                <SortButton
                  label="PRs"
                  sortKey="prs"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onClick={onSort}
                  align="right"
                />
              </th>
              <th className="px-5 py-3 text-right" aria-sort={getAriaSort("messageCount")}>
                <SortButton
                  label="Messages"
                  sortKey="messageCount"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onClick={onSort}
                  align="right"
                />
              </th>
              <th className="px-5 py-3 text-right" aria-sort={getAriaSort("cost")}>
                <SortButton
                  label="Total Cost"
                  sortKey="cost"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onClick={onSort}
                  align="right"
                />
              </th>
              <th className="px-5 py-3 text-right" aria-sort={getAriaSort("avgDuration")}>
                <SortButton
                  label="Avg Duration"
                  sortKey="avgDuration"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onClick={onSort}
                  align="right"
                />
              </th>
              <th className="px-5 py-3 text-right" aria-sort={getAriaSort("lastActive")}>
                <SortButton
                  label="Last Active"
                  sortKey="lastActive"
                  activeKey={sortKey}
                  direction={sortDirection}
                  onClick={onSort}
                  align="right"
                />
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr
                key={entry.key}
                className="border-b border-border-muted last:border-b-0 hover:bg-muted/50"
              >
                <td className="px-5 py-4">
                  <UserCell entry={entry} />
                </td>
                <td className="px-5 py-4">
                  <SessionsCell entry={entry} />
                </td>
                <td className="px-5 py-4 text-right">
                  <CompletionRateCell entry={entry} />
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatAnalyticsCount(entry.prs)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatAnalyticsCount(entry.messageCount)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {formatSessionCost(entry.cost)}
                </td>
                <td className="px-5 py-4 text-right text-foreground">
                  {entry.avgDuration > 0 ? formatAnalyticsDuration(entry.avgDuration) : "—"}
                </td>
                <td className="px-5 py-4 text-right text-muted-foreground">
                  {formatRelativeTime(entry.lastActive)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t border-border-muted px-5 py-3 text-xs text-muted-foreground">
        Click any column heading to change the sort order.
      </div>
    </div>
  );
}
