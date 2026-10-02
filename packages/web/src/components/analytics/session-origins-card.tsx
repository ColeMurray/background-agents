"use client";

import { useId, useState } from "react";
import type { AnalyticsSessionOriginEntry } from "@open-inspect/shared/types/analytics";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import { formatAnalyticsCount, formatAnalyticsRatio } from "@/lib/analytics";
import { cn } from "@/lib/utils";

const SOURCES: Record<SpawnSource, { label: string; color: string }> = {
  user: { label: "User / app", color: "bg-accent" },
  "slack-bot": { label: "Slack", color: "bg-info" },
  "github-bot": { label: "GitHub", color: "bg-foreground" },
  "linear-bot": { label: "Linear", color: "bg-secondary-foreground" },
  agent: { label: "Agent sub-sessions", color: "bg-warning" },
  automation: { label: "Automations", color: "bg-success" },
};

export function AnalyticsSessionOriginsCard({
  entries,
  loading,
}: {
  entries?: AnalyticsSessionOriginEntry[];
  loading: boolean;
}) {
  const headingId = useId();
  const usersId = useId();
  const [selectedSource, setSelectedSource] = useState<SpawnSource | null>(null);
  const sourceCounts = new Map<SpawnSource, number>();
  for (const entry of entries ?? []) {
    sourceCounts.set(entry.source, (sourceCounts.get(entry.source) ?? 0) + entry.sessions);
  }
  const sources = [...sourceCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = sources.reduce((sum, [, count]) => sum + count, 0);
  if (selectedSource && entries && !sourceCounts.has(selectedSource)) {
    setSelectedSource(null);
  }
  const source = selectedSource && sourceCounts.has(selectedSource) ? selectedSource : null;
  const selectedTotal = source ? sourceCounts.get(source)! : total;
  const users = new Map<string, { name: string; sessions: number }>();
  for (const entry of entries ?? []) {
    if (source && entry.source !== source) continue;
    const previous = users.get(entry.userKey);
    users.set(entry.userKey, {
      name: entry.displayName,
      sessions: (previous?.sessions ?? 0) + entry.sessions,
    });
  }
  const sortedUsers = [...users].sort(
    (a, b) => b[1].sessions - a[1].sessions || a[0].localeCompare(b[0])
  );
  const nameCounts = new Map<string, number>();
  for (const user of users.values()) {
    nameCounts.set(user.name, (nameCounts.get(user.name) ?? 0) + 1);
  }
  const sourceLabel = source ? SOURCES[source].label : "All sources";

  return (
    <section
      aria-labelledby={headingId}
      aria-busy={loading}
      className="rounded-md border border-border-muted bg-card"
    >
      <div className="border-b border-border-muted p-4 sm:px-5">
        <h2 id={headingId} className="text-lg font-semibold text-foreground">
          Session origins
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Where sessions start and who they are attributed to. Select a source to see its users.
        </p>
      </div>

      {loading && !entries ? (
        <div role="status" className="p-5 text-sm text-muted-foreground">
          Loading session origins...
        </div>
      ) : !total ? (
        <div className="p-5 text-sm text-muted-foreground">
          No sessions found for this range and scope.
        </div>
      ) : (
        <div className="grid md:grid-cols-2">
          <div className="min-w-0 border-b border-border-muted p-4 sm:p-5 md:border-b-0 md:border-r">
            <div className="mb-3 flex items-center justify-between gap-3">
              <h3 className="text-xs uppercase tracking-wider text-secondary-foreground">
                By source
              </h3>
              <button
                type="button"
                aria-pressed={source === null}
                aria-controls={usersId}
                onClick={() => setSelectedSource(null)}
                className="rounded px-2 py-1 text-xs text-accent hover:bg-accent-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
              >
                All sources
              </button>
            </div>
            <ul className="space-y-1">
              {sources.map(([key, count]) => (
                <li key={key}>
                  <button
                    type="button"
                    aria-pressed={source === key}
                    aria-controls={usersId}
                    onClick={() => setSelectedSource(source === key ? null : key)}
                    className={cn(
                      "w-full rounded-md border p-3 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                      source === key
                        ? "border-accent bg-accent-muted"
                        : "border-transparent hover:bg-muted"
                    )}
                  >
                    <span className="flex items-center justify-between gap-3 text-sm">
                      <span className="font-medium text-foreground">{SOURCES[key].label}</span>
                      <span className="shrink-0 tabular-nums text-foreground">
                        {formatAnalyticsCount(count)}
                        <span className="ml-3 text-xs text-muted-foreground">
                          {formatAnalyticsRatio(count / total)}
                        </span>
                      </span>
                    </span>
                    <span aria-hidden="true" className="mt-2 block h-1.5 rounded-full bg-muted">
                      <span
                        className={cn("block h-full rounded-full", SOURCES[key].color)}
                        style={{ width: `${(count / total) * 100}%` }}
                      />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">
              {formatAnalyticsCount(total)} sessions. Percentages use the selected range and scope.
            </p>
          </div>

          <div id={usersId} className="min-w-0 p-4 sm:p-5">
            <h3 className="text-xs uppercase tracking-wider text-secondary-foreground">
              Attributed users
            </h3>
            <p role="status" className="mt-2 text-sm text-muted-foreground">
              {sourceLabel}: {formatAnalyticsCount(selectedTotal)} sessions
            </p>
            <ol
              aria-label={`Users for ${sourceLabel}`}
              tabIndex={0}
              className="mt-3 max-h-80 overflow-y-auto rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
            >
              {sortedUsers.map(([key, user]) => (
                <li
                  key={key}
                  className="flex items-start justify-between gap-4 border-b border-border-muted py-3 last:border-0"
                >
                  <div className="min-w-0">
                    <div className="break-words text-sm font-medium text-foreground">
                      {user.name}
                    </div>
                    {key === "__unknown__" || nameCounts.get(user.name)! > 1 ? (
                      <div className="mt-0.5 break-all text-xs text-muted-foreground">
                        {key === "__unknown__" ? "No recorded user" : key}
                      </div>
                    ) : null}
                  </div>
                  <div className="shrink-0 text-right tabular-nums">
                    <div className="text-sm font-medium text-foreground">
                      {formatAnalyticsCount(user.sessions)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted-foreground">
                      {formatAnalyticsRatio(user.sessions / selectedTotal)}
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          </div>
        </div>
      )}

      <details className="border-t border-border-muted px-4 py-3 text-xs leading-5 text-muted-foreground sm:px-5">
        <summary className="cursor-pointer w-fit rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
          How attribution works
        </summary>
        <p className="mt-2">
          Counts sessions created in the selected range and scope, including drafts, failures and
          archived sessions. Private sessions are excluded. Sources describe creation, not later
          messages or interactions. User / app includes user-authenticated creation and historical
          sessions whose source defaulted to user; it does not mean browser-only usage.
        </p>
        <p className="mt-2">
          Users reflect recorded attribution: the requesting actor, the attributed user for an agent
          sub-session, or the automation owner or manual triggerer. Integration actors are not
          always people. Older sessions may use a separate legacy login or have no recorded user.
        </p>
      </details>
    </section>
  );
}
