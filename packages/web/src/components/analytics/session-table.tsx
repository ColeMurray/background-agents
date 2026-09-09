"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { AnalyticsBreakdownEntry } from "@open-inspect/shared/types/analytics";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatAnalyticsCount, formatAnalyticsDuration } from "@/lib/analytics";
import { formatSessionCost } from "@/lib/session-cost";
import { formatRelativeTime } from "@/lib/time";

const PAGE_SIZE = 25;
const columns = [
  ["displayName", "Session"],
  ["user", "User"],
  ["status", "Status"],
  ["totalTokens", "Tokens"],
  ["messageCount", "Messages"],
  ["cost", "Reported cost"],
  ["avgDuration", "Active duration"],
  ["lastActive", "Last active"],
] as const;
type SortKey = (typeof columns)[number][0];

export function AnalyticsSessionTable({
  entries,
  loading,
}: {
  entries?: AnalyticsBreakdownEntry[];
  loading: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("lastActive");
  const [ascending, setAscending] = useState(false);
  const [page, setPage] = useState(0);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return (entries ?? [])
      .filter((entry) =>
        [entry.key, entry.displayName, entry.repository, entry.user].some((value) =>
          value?.toLowerCase().includes(search)
        )
      )
      .sort((a, b) => {
        const left = a[sortKey];
        const right = b[sortKey];
        if (left == null || right == null) return left == null ? (right == null ? 0 : 1) : -1;
        const comparison =
          typeof left === "number" && typeof right === "number"
            ? left - right
            : String(left).localeCompare(String(right));
        return (ascending ? comparison : -comparison) || a.key.localeCompare(b.key);
      });
  }, [entries, query, sortKey, ascending]);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1));
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);

  return (
    <section
      className="rounded-md border border-border-muted bg-card"
      aria-label="Session analytics"
    >
      <div className="border-b border-border-muted px-5 py-4">
        <h2 className="text-lg font-semibold text-foreground">Per-session usage</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Usage for threads created in the selected range, updated after each turn finishes. Tokens
          include cached and reasoning tokens, even when no API cost is reported.
        </p>
        <Input
          className="mt-4 max-w-sm"
          aria-label="Search sessions"
          placeholder="Search sessions, repositories, or users"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
          }}
        />
      </div>
      {loading && !entries ? (
        <p className="p-5 text-sm text-muted-foreground" role="status">
          Loading session usage...
        </p>
      ) : !filtered.length ? (
        <p className="p-5 text-sm text-muted-foreground">
          {query ? "No sessions match your search." : "No sessions found for this range."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm tabular-nums">
            <thead>
              <tr className="border-b border-border-muted text-left text-secondary-foreground">
                {columns.map(([key, label], index) => (
                  <th
                    key={key}
                    className={`px-5 py-3 ${index > 2 ? "text-right" : ""}`}
                    aria-sort={sortKey === key ? (ascending ? "ascending" : "descending") : "none"}
                  >
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setAscending(
                          sortKey === key
                            ? !ascending
                            : key === "displayName" || key === "user" || key === "status"
                        );
                        setSortKey(key);
                        setPage(0);
                      }}
                    >
                      {label}
                      {sortKey === key ? (ascending ? " ↑" : " ↓") : ""}
                    </Button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((entry) => (
                <tr
                  key={entry.key}
                  className="border-b border-border-muted last:border-b-0 hover:bg-muted/50"
                >
                  <td className="px-5 py-4 min-w-60 max-w-sm">
                    <Link
                      href={`/session/${encodeURIComponent(entry.key)}`}
                      className="font-medium text-accent hover:underline break-words"
                    >
                      {entry.displayName ?? entry.key}
                    </Link>
                    <div className="mt-1 text-xs text-muted-foreground">
                      {entry.repository ?? "No repository"}
                    </div>
                  </td>
                  <td className="px-5 py-4">{entry.user ?? "Unknown user"}</td>
                  <td className="px-5 py-4 capitalize">{entry.status}</td>
                  <td className="px-5 py-4 text-right">
                    {entry.totalTokens == null ? (
                      <span className="text-muted-foreground">Not reported</span>
                    ) : (
                      formatAnalyticsCount(entry.totalTokens)
                    )}
                  </td>
                  <td className="px-5 py-4 text-right">
                    {formatAnalyticsCount(entry.messageCount)}
                  </td>
                  <td className="px-5 py-4 text-right">{formatSessionCost(entry.cost)}</td>
                  <td className="px-5 py-4 text-right">
                    {formatAnalyticsDuration(entry.avgDuration)}
                  </td>
                  <td className="px-5 py-4 text-right text-muted-foreground whitespace-nowrap">
                    {formatRelativeTime(entry.lastActive)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border-muted px-5 py-3 text-xs text-muted-foreground">
        <p>
          Token counts are available for newly recorded turns. Unreported usage does not mean zero
          usage.
        </p>
        {filtered.length > PAGE_SIZE && (
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={currentPage === 0}
              onClick={() => setPage(currentPage - 1)}
            >
              Previous
            </Button>
            <span>
              Page {currentPage + 1} of {Math.ceil(filtered.length / PAGE_SIZE)}
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={(currentPage + 1) * PAGE_SIZE >= filtered.length}
              onClick={() => setPage(currentPage + 1)}
            >
              Next
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
