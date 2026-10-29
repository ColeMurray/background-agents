"use client";

import { useId, useMemo, useState } from "react";
import type { AnalyticsSessionOriginEntry } from "@open-inspect/shared/types/analytics";
import type { SpawnSource } from "@open-inspect/shared/types/sessions";
import {
  ANALYTICS_SOURCE_LABELS,
  ANALYTICS_UNKNOWN_USER_KEY,
  formatAnalyticsCount,
  formatAnalyticsRatio,
  getSessionsBySource,
} from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { AnalyticsEmptyNote } from "./analytics-panel";
import { AnalyticsRankedBars } from "./analytics-ranked-bars";

/**
 * Sessions by source beside the users they are attributed to. Selecting a
 * source narrows the users to it. Remount it (via `key`) when the range or
 * scope changes so the selection starts over.
 */
export function AnalyticsSessionSources({ entries }: { entries: AnalyticsSessionOriginEntry[] }) {
  const usersId = useId();
  const sources = useMemo(() => getSessionsBySource(entries), [entries]);
  const [selected, setSelected] = useState<SpawnSource | null>(null);
  const active = sources.find((source) => source.source === selected) ?? null;
  if (selected && !active) {
    // Refreshed data no longer has this source; fall back to all sources for good.
    setSelected(null);
  }

  const total = sources.reduce((sum, source) => sum + source.sessions, 0);
  const users = useMemo(() => {
    if (active) return active.users;
    const merged = new Map<string, { key: string; name: string; sessions: number }>();
    for (const entry of entries) {
      const user = merged.get(entry.userKey) ?? {
        key: entry.userKey,
        name: entry.displayName,
        sessions: 0,
      };
      user.sessions += entry.sessions;
      merged.set(entry.userKey, user);
    }
    return [...merged.values()].sort(
      (a, b) => b.sessions - a.sessions || a.key.localeCompare(b.key)
    );
  }, [active, entries]);

  if (!total) {
    return <AnalyticsEmptyNote>No sessions found for this range and scope.</AnalyticsEmptyNote>;
  }

  const sourceLabel = active ? ANALYTICS_SOURCE_LABELS[active.source] : "All sources";
  const selectedTotal = active ? active.sessions : total;
  const nameCounts = new Map<string, number>();
  for (const user of users) nameCounts.set(user.name, (nameCounts.get(user.name) ?? 0) + 1);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="min-w-0">
        <div className="mb-1 flex items-center justify-between gap-3 px-2">
          <span className="text-xs text-muted-foreground">By source</span>
          <button
            type="button"
            aria-pressed={active === null}
            aria-controls={usersId}
            onClick={() => setSelected(null)}
            className={cn(
              "rounded px-1.5 py-0.5 text-xs font-medium text-accent hover:bg-accent-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
              active === null && "bg-accent-muted"
            )}
          >
            All sources
          </button>
        </div>
        <AnalyticsRankedBars
          label="Sessions by source"
          rows={sources.map((source) => ({
            key: source.source,
            label: ANALYTICS_SOURCE_LABELS[source.source],
            value: source.sessions,
            display: formatAnalyticsCount(source.sessions),
            secondary: formatAnalyticsRatio(source.sessions / total),
          }))}
          selected={active?.source ?? null}
          controls={usersId}
          onSelect={(key) => {
            const source = sources.find((candidate) => candidate.source === key)?.source ?? null;
            setSelected((current) => (current === source ? null : source));
          }}
        />
      </div>
      <div id={usersId} className="min-w-0">
        <p role="status" className="px-2 text-xs text-muted-foreground">
          {sourceLabel}: {formatAnalyticsCount(selectedTotal)} sessions
        </p>
        <ol
          aria-label={`Users for ${sourceLabel}`}
          // Focusable so keyboard users can scroll a long list.
          tabIndex={0}
          className="mt-2 max-h-72 overflow-y-auto rounded px-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
        >
          {users.map((user) => (
            <li
              key={user.key}
              className="flex items-baseline justify-between gap-3 border-b border-border-muted py-1.5 text-sm last:border-0"
            >
              <span className="min-w-0">
                <span className="block break-words">{user.name}</span>
                {user.key === ANALYTICS_UNKNOWN_USER_KEY || (nameCounts.get(user.name) ?? 0) > 1 ? (
                  <span className="block break-all text-xs text-muted-foreground">
                    {user.key === ANALYTICS_UNKNOWN_USER_KEY ? "No recorded user" : user.key}
                  </span>
                ) : null}
              </span>
              <span className="shrink-0 tabular-nums">
                {formatAnalyticsCount(user.sessions)}
                <span className="ml-2 inline-block min-w-[2.75rem] text-right text-xs text-muted-foreground">
                  {formatAnalyticsRatio(user.sessions / selectedTotal)}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/** How sources and users are attributed; shown under the sources breakdown. */
export function AnalyticsAttributionNote() {
  return (
    <details>
      <summary className="w-fit cursor-pointer rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring">
        How attribution works
      </summary>
      <p className="mt-2 leading-5">
        Counts sessions created in the selected range and scope, including drafts, failures and
        archived sessions. Private sessions are excluded. Sources describe creation, not later
        messages or interactions. User / app includes user-authenticated creation and historical
        sessions whose source defaulted to user; it does not mean browser-only usage.
      </p>
      <p className="mt-2 leading-5">
        Users reflect recorded attribution: the requesting actor, the attributed user for an agent
        sub-session, or the automation owner or manual triggerer. Integration actors are not always
        people. Older sessions may use a separate legacy login or have no recorded user.
      </p>
    </details>
  );
}
