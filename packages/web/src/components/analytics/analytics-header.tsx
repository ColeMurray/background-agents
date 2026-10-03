"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  ANALYTICS_DAYS,
  ANALYTICS_SCOPES,
  type AnalyticsDashboardResponse,
  type AnalyticsDays,
  type AnalyticsScope,
} from "@open-inspect/shared/types/analytics";
import { CollapsedSidebarControls, useSidebarContext } from "@/components/sidebar-layout";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { cn } from "@/lib/utils";
import {
  ANALYTICS_RANGE_LABELS,
  ANALYTICS_REFRESH_INTERVAL_MS,
  ANALYTICS_SCOPE_DESCRIPTIONS,
  ANALYTICS_SCOPE_LABELS,
  formatAnalyticsWindow,
} from "@/lib/analytics";

const RANGE_OPTIONS = ANALYTICS_DAYS.map((days) => ({
  value: String(days) as `${AnalyticsDays}`,
  label: ANALYTICS_RANGE_LABELS[days],
}));

const SCOPE_OPTIONS = ANALYTICS_SCOPES.map((scope) => ({
  value: scope,
  label: ANALYTICS_SCOPE_LABELS[scope],
}));

/**
 * The page header as one toolbar row (title, window, freshness, then the filters
 * that scope everything below) with the tab list beneath it.
 */
export function AnalyticsHeader({
  dashboard,
  days,
  scope,
  onDaysChange,
  onScopeChange,
  scopeDisabled,
  freshness,
  tabs,
}: {
  dashboard?: AnalyticsDashboardResponse;
  days: AnalyticsDays;
  scope: AnalyticsScope;
  onDaysChange: (days: AnalyticsDays) => void;
  onScopeChange: (scope: AnalyticsScope) => void;
  /** Pull request metrics ignore scope, so their tab turns the control off. */
  scopeDisabled: boolean;
  /** Whether the numbers on screen match the selected filters. */
  freshness: AnalyticsFreshness;
  tabs: ReactNode;
}) {
  const { isOpen } = useSidebarContext();
  return (
    <header className="sticky top-0 z-20 border-b border-border-muted bg-[color-mix(in_srgb,var(--background)_88%,transparent)] backdrop-blur">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-4 pt-2.5 sm:px-6 lg:px-8">
        {!isOpen && <CollapsedSidebarControls />}
        <div className="flex min-w-0 flex-1 items-baseline gap-3">
          <h1 className="text-lg font-semibold text-foreground">Analytics</h1>
          {dashboard ? (
            <span className="hidden text-xs text-muted-foreground md:inline">
              {formatAnalyticsWindow(dashboard.window)}
            </span>
          ) : null}
          <LiveStatus generatedAt={dashboard?.generatedAt} freshness={freshness} />
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div
            className="flex items-center"
            title={scopeDisabled ? "Pull request metrics include every source" : undefined}
          >
            <SegmentedControl
              label="Session scope"
              value={scope}
              options={SCOPE_OPTIONS}
              onValueChange={onScopeChange}
              disabled={scopeDisabled}
            />
            <ScopeHelp />
          </div>
          <SegmentedControl
            label="Time range"
            value={String(days) as `${AnalyticsDays}`}
            options={RANGE_OPTIONS}
            onValueChange={(value) => onDaysChange(Number(value) as AnalyticsDays)}
          />
        </div>
      </div>
      <div className="mx-auto flex max-w-7xl items-end justify-between gap-4 px-4 sm:px-6 lg:px-8">
        {tabs}
        <div className="shrink-0 pb-1">
          <AboutThisData />
        </div>
      </div>
    </header>
  );
}

export type AnalyticsFreshness = "current" | "loading" | "previous";

/** "Updated 12s ago" beside a live dot; ticks on its own between refreshes. */
function LiveStatus({
  generatedAt,
  freshness,
}: {
  generatedAt?: number;
  freshness: AnalyticsFreshness;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 5_000);
    return () => window.clearInterval(timer);
  }, []);
  if (generatedAt === undefined) return null;
  if (freshness !== "current") {
    return (
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "h-1.5 w-1.5 rounded-full",
            freshness === "loading" ? "animate-pulse bg-muted-foreground" : "bg-warning"
          )}
        />
        {freshness === "loading" ? "Loading…" : "Showing the previous selection"}
      </span>
    );
  }

  const seconds = Math.max(0, Math.round((now - generatedAt) / 1000));
  const age =
    seconds < 5
      ? "just now"
      : seconds < 60
        ? `${seconds}s ago`
        : `${Math.round(seconds / 60)}m ago`;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success" />
      Updated {age}
    </span>
  );
}

function InfoIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" className="h-3.5 w-3.5">
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.25" />
      <path d="M8 7.25v3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
      <circle cx="8" cy="5.1" r="0.8" fill="currentColor" />
    </svg>
  );
}

function ScopeHelp() {
  return (
    <Popover>
      <PopoverTrigger
        aria-label="What each session scope includes"
        className="rounded p-1 text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <InfoIcon />
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-3 text-xs leading-5">
        <div className="mb-1.5 text-sm font-medium text-foreground">Session scope</div>
        <dl className="space-y-1.5">
          {ANALYTICS_SCOPES.map((option) => (
            <div key={option} className="grid grid-cols-[6.5rem_1fr] gap-2">
              <dt className="font-medium text-foreground">{ANALYTICS_SCOPE_LABELS[option]}</dt>
              <dd className="text-muted-foreground">{ANALYTICS_SCOPE_DESCRIPTIONS[option]}</dd>
            </div>
          ))}
        </dl>
        <p className="mt-2 border-t border-border-muted pt-2 text-muted-foreground">
          Pull request metrics always include every source.
        </p>
      </PopoverContent>
    </Popover>
  );
}

function AboutThisData() {
  return (
    <Popover>
      <PopoverTrigger
        aria-label="About this data"
        className="inline-flex items-center gap-1 rounded px-1.5 py-1 text-xs text-muted-foreground hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <InfoIcon />
        {/* Icon only on phones, where the tabs need the width. */}
        <span className="hidden sm:inline">About this data</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-3 text-xs leading-5 text-muted-foreground">
        <div className="mb-1.5 text-sm font-medium text-foreground">About this data</div>
        <ul className="list-disc space-y-1 pl-4">
          <li>Refreshes every {ANALYTICS_REFRESH_INTERVAL_MS / 1000} seconds.</li>
          <li>Private sessions are excluded.</li>
          <li>Legacy sessions are included and may show zero cost, PRs or duration.</li>
          <li>Token totals start when token capture was enabled; older sessions count as zero.</li>
          <li>
            PR counts reflect pull requests created through the platform&apos;s built-in flow,
            including automation-created ones.
          </li>
          <li>Sessions billed to a connected subscription report $0 cost.</li>
        </ul>
      </PopoverContent>
    </Popover>
  );
}
