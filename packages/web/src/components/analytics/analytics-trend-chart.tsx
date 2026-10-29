"use client";

import { useId } from "react";
import type { TooltipContentProps } from "recharts";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { formatAnalyticsCount, formatAnalyticsDate } from "@/lib/analytics";
import { cn } from "@/lib/utils";
import { AnalyticsEmptyNote } from "./analytics-panel";

const TOOLTIP_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

export interface AnalyticsTrendSeries {
  key: string;
  label: string;
  color: string;
  /** A soft wash under the line; context series stay a plain line. */
  fill?: boolean;
}

function TrendTooltip({
  active,
  payload,
  series,
}: TooltipContentProps & { series: AnalyticsTrendSeries[] }) {
  const row = payload?.[0]?.payload as Record<string, number | string> | undefined;
  if (!active || !row) return null;
  const date = String(row.date);
  // The newest bucket covers only part of today.
  const partial = date === new Date().toISOString().slice(0, 10);
  return (
    <div className="min-w-[10rem] rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="mb-1.5 text-muted-foreground">
        {TOOLTIP_DATE_FORMATTER.format(new Date(`${date}T00:00:00Z`))}
        {partial ? " · today so far" : null}
      </div>
      <div className="space-y-1">
        {series.map((item) => (
          <div key={item.key} className="flex items-center gap-2">
            <span className="h-0.5 w-3 rounded-full" style={{ background: item.color }} />
            <span className="font-semibold tabular-nums text-foreground">
              {formatAnalyticsCount(Number(row[item.key] ?? 0))}
            </span>
            <span className="text-muted-foreground">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Daily counts across the window: 2px lines, a soft wash, one tooltip for every series. */
export function AnalyticsTrendChart<Row extends { date: string }>({
  data,
  series,
  height = 220,
  emptyMessage,
}: {
  data: Row[];
  series: AnalyticsTrendSeries[];
  /** Pixels, or "fill" to take the height of a panel its grid row stretches. */
  height?: number | "fill";
  emptyMessage: string;
}) {
  const gradientPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const hasActivity = data.some((row) =>
    series.some((item) => Number((row as Record<string, unknown>)[item.key] ?? 0) > 0)
  );
  if (!hasActivity) return <AnalyticsEmptyNote>{emptyMessage}</AnalyticsEmptyNote>;

  return (
    <div
      style={height === "fill" ? undefined : { height }}
      className={cn("w-full", height === "fill" && "h-full min-h-[220px]")}
    >
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 6, right: 8, left: -12, bottom: 0 }}>
          <defs>
            {series.map((item) => (
              <linearGradient
                key={item.key}
                id={`${gradientPrefix}-${item.key}`}
                x1="0"
                y1="0"
                x2="0"
                y2="1"
              >
                <stop offset="0%" stopColor={item.color} stopOpacity={0.16} />
                <stop offset="100%" stopColor={item.color} stopOpacity={0.02} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke="var(--border-muted)" vertical={false} />
          <XAxis
            dataKey="date"
            tickFormatter={formatAnalyticsDate}
            axisLine={false}
            tickLine={false}
            minTickGap={36}
            interval="preserveStartEnd"
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <YAxis
            allowDecimals={false}
            axisLine={false}
            tickLine={false}
            width={44}
            tickFormatter={formatAnalyticsCount}
            tick={{ fill: "var(--muted-foreground)", fontSize: 11 }}
          />
          <Tooltip
            cursor={{ stroke: "var(--border)", strokeWidth: 1 }}
            content={(props) => <TrendTooltip {...props} series={series} />}
          />
          {series.map((item) => (
            <Area
              key={item.key}
              type="monotone"
              dataKey={item.key}
              stroke={item.color}
              strokeWidth={2}
              fill={item.fill === false ? "transparent" : `url(#${gradientPrefix}-${item.key})`}
              dot={false}
              activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--background)" }}
              isAnimationActive={false}
            />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

export function AnalyticsLegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <span aria-hidden="true" className="h-0.5 w-3 rounded-full" style={{ background: color }} />
      {label}
    </span>
  );
}

export const SESSION_TREND_SERIES: AnalyticsTrendSeries[] = [
  { key: "sessions", label: "sessions", color: "var(--accent)" },
];

/** Opened is context, drawn as a plain muted line; merged is the outcome, in the accent. */
export const PULL_REQUEST_TREND_SERIES: AnalyticsTrendSeries[] = [
  { key: "created", label: "opened", color: "var(--muted-foreground)", fill: false },
  { key: "merged", label: "merged", color: "var(--accent)" },
];
