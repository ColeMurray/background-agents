"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { AnalyticsEmptyNote } from "./analytics-panel";

export interface AnalyticsRankedRow {
  key: string;
  label: string;
  value: number;
  display: string;
  secondary?: ReactNode;
}

/**
 * Categories ranked by one measure. Every bar shares one hue (the categories are
 * nominal), and each label sits above its bar so long names are never clipped.
 */
export function AnalyticsRankedBars({
  rows,
  label,
  limit,
  selected,
  onSelect,
  controls,
  emptyMessage = "Nothing in this range.",
}: {
  rows: AnalyticsRankedRow[];
  label: string;
  limit?: number;
  selected?: string | null;
  onSelect?: (key: string) => void;
  /** Id of the element that selecting a row updates. */
  controls?: string;
  emptyMessage?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  if (!rows.length) return <AnalyticsEmptyNote>{emptyMessage}</AnalyticsEmptyNote>;

  const max = Math.max(...rows.map((row) => row.value), 1);
  const visible = limit && !expanded ? rows.slice(0, limit) : rows;

  return (
    <div>
      <ul aria-label={label} className="space-y-1">
        {visible.map((row) => {
          const content = (
            <>
              <span className="flex items-baseline justify-between gap-3 text-sm">
                <span className="min-w-0 truncate text-foreground" title={row.label}>
                  {row.label}
                </span>
                <span className="shrink-0 tabular-nums text-foreground">
                  {row.display}
                  {row.secondary !== undefined ? (
                    <span className="ml-2 inline-block min-w-[2.75rem] text-right text-xs text-muted-foreground">
                      {row.secondary}
                    </span>
                  ) : null}
                </span>
              </span>
              <span aria-hidden="true" className="mt-1 block h-1.5 rounded-full bg-muted">
                <span
                  className="block h-full rounded-full bg-accent"
                  style={{
                    width: `${Math.max((row.value / max) * 100, row.value > 0 ? 1.5 : 0)}%`,
                  }}
                />
              </span>
            </>
          );
          return (
            <li key={row.key}>
              {onSelect ? (
                <button
                  type="button"
                  aria-pressed={selected === row.key}
                  aria-controls={controls}
                  onClick={() => onSelect(row.key)}
                  className={cn(
                    "block w-full rounded-md px-2 py-1.5 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring",
                    selected === row.key ? "bg-accent-muted" : "hover:bg-muted"
                  )}
                >
                  {content}
                </button>
              ) : (
                <div className="px-2 py-1.5">{content}</div>
              )}
            </li>
          );
        })}
      </ul>
      {limit && rows.length > limit ? (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          className="mt-2 rounded px-2 py-1 text-xs font-medium text-accent hover:bg-accent-muted"
        >
          {expanded ? "Show fewer" : `Show all ${rows.length}`}
        </button>
      ) : null}
    </div>
  );
}
