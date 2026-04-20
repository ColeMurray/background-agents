import { useId } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalyticsTimeseriesResponse } from "@open-inspect/shared";
import { Badge } from "@/components/ui/badge";
import {
  buildTimeseriesChartData,
  formatAnalyticsCount,
  formatAnalyticsLongDate,
} from "@/lib/analytics";

interface TimeseriesChartProps {
  series?: AnalyticsTimeseriesResponse["series"];
  loading: boolean;
}

const SERIES_COLORS = [
  "var(--accent)",
  "var(--success)",
  "var(--info)",
  "#c08429",
  "#ef4444",
  "#0f766e",
  "#8b5cf6",
  "#ea580c",
  "#14b8a6",
  "#e11d48",
];

export function AnalyticsTimeseriesChart({ series, loading }: TimeseriesChartProps) {
  const chartIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  if (loading && !series) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5 animate-pulse">
        <div className="h-4 w-40 rounded bg-muted" />
        <div className="mt-2 h-4 w-72 rounded bg-muted" />
        <div className="mt-6 h-[320px] rounded bg-muted" />
      </div>
    );
  }

  if (!series?.length) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5">
        <div className="text-lg font-semibold text-foreground">Sessions Over Time</div>
        <p className="mt-1 text-sm text-muted-foreground">No sessions found for this range.</p>
      </div>
    );
  }

  const { data, groupKeys } = buildTimeseriesChartData(series);
  const previewGroups = groupKeys.slice(0, 5);
  const hiddenGroups = Math.max(groupKeys.length - previewGroups.length, 0);

  function getGradientId(groupKey: string, index: number) {
    const safeKey = groupKey.replace(/[^a-zA-Z0-9_-]/g, "-");
    return `${chartIdPrefix}-analytics-series-${index}-${safeKey}`;
  }

  return (
    <div className="rounded-md border border-border-muted bg-card p-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Sessions Over Time</h2>
          <p className="text-sm text-muted-foreground">Daily session counts stacked by user.</p>
        </div>
        <div className="flex flex-wrap gap-2 pt-2 sm:justify-end">
          {previewGroups.map((groupKey) => (
            <Badge key={groupKey} variant="default">
              {groupKey}
            </Badge>
          ))}
          {hiddenGroups > 0 ? <Badge variant="pr-draft">+{hiddenGroups} more</Badge> : null}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-border-muted bg-background p-3 sm:p-4">
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                {groupKeys.map((groupKey, index) => {
                  const color = SERIES_COLORS[index % SERIES_COLORS.length];
                  const gradientId = getGradientId(groupKey, index);
                  return (
                    <linearGradient key={groupKey} id={gradientId} x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor={color} stopOpacity={0.32} />
                      <stop offset="95%" stopColor={color} stopOpacity={0.06} />
                    </linearGradient>
                  );
                })}
              </defs>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="label"
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              />
              <YAxis
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              />
              <Tooltip
                contentStyle={{
                  backgroundColor: "var(--popover)",
                  border: "1px solid var(--border)",
                  borderRadius: "6px",
                  color: "var(--popover-foreground)",
                }}
                labelFormatter={(_, payload) => {
                  const rowDate = payload?.[0]?.payload?.date;
                  return typeof rowDate === "string" ? formatAnalyticsLongDate(rowDate) : "";
                }}
                formatter={(value, name) => {
                  const count = typeof value === "number" ? value : Number(value ?? 0);
                  return [formatAnalyticsCount(count), String(name)];
                }}
              />
              {groupKeys.map((groupKey, index) => {
                const color = SERIES_COLORS[index % SERIES_COLORS.length];
                const gradientId = getGradientId(groupKey, index);
                return (
                  <Area
                    key={groupKey}
                    type="monotone"
                    dataKey={groupKey}
                    stackId="sessions"
                    stroke={color}
                    fill={`url(#${gradientId})`}
                    strokeWidth={2}
                    dot={false}
                    activeDot={{ r: 3 }}
                  />
                );
              })}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        Hover the chart to inspect stacked daily counts for each user.
      </div>
    </div>
  );
}
