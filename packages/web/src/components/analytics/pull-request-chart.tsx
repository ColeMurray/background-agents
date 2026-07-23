import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useId } from "react";
import type { AnalyticsPullRequestTimeseriesPoint } from "@open-inspect/shared";
import { Badge } from "@/components/ui/badge";
import {
  formatAnalyticsCount,
  formatAnalyticsDate,
  formatAnalyticsLongDate,
} from "@/lib/analytics";

interface PullRequestChartProps {
  timeseries?: AnalyticsPullRequestTimeseriesPoint[];
  loading: boolean;
}

const SERIES = [
  { key: "created", label: "Created", color: "var(--accent)" },
  { key: "merged", label: "Merged", color: "var(--success)" },
] as const;

export function AnalyticsPullRequestChart({ timeseries, loading }: PullRequestChartProps) {
  const chartIdPrefix = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  if (loading && !timeseries) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5 animate-pulse">
        <div className="h-4 w-40 rounded bg-muted" />
        <div className="mt-2 h-4 w-72 rounded bg-muted" />
        <div className="mt-6 h-[320px] rounded bg-muted" />
      </div>
    );
  }

  if (!timeseries?.length) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5">
        <div className="text-lg font-semibold text-foreground">Pull Requests Over Time</div>
        <p className="mt-1 text-sm text-muted-foreground">No pull requests found for this range.</p>
      </div>
    );
  }

  const data = timeseries.map((point) => ({
    ...point,
    label: formatAnalyticsDate(point.date),
  }));
  const labelMap = Object.fromEntries(SERIES.map((series) => [series.key, series.label]));

  return (
    <div className="rounded-md border border-border-muted bg-card p-5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Pull Requests Over Time</h2>
          <p className="text-sm text-muted-foreground">Daily created vs merged counts.</p>
        </div>
        <div className="flex flex-wrap gap-2 pt-2 sm:justify-end">
          {SERIES.map((series) => (
            <Badge key={series.key} variant="default">
              {series.label}
            </Badge>
          ))}
        </div>
      </div>

      <div className="mt-6 rounded-lg border border-border-muted bg-background p-3 sm:p-4">
        <div className="h-[320px]">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                {SERIES.map((series) => (
                  <linearGradient
                    key={series.key}
                    id={`${chartIdPrefix}-pr-series-${series.key}`}
                    x1="0"
                    y1="0"
                    x2="0"
                    y2="1"
                  >
                    <stop offset="5%" stopColor={series.color} stopOpacity={0.18} />
                    <stop offset="95%" stopColor={series.color} stopOpacity={0.03} />
                  </linearGradient>
                ))}
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
                  return [formatAnalyticsCount(count), labelMap[String(name)] ?? String(name)];
                }}
              />
              {SERIES.map((series) => (
                <Area
                  key={series.key}
                  type="monotone"
                  dataKey={series.key}
                  stroke={series.color}
                  fill={`url(#${chartIdPrefix}-pr-series-${series.key})`}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3 }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        Created is bucketed by when the PR was opened; merged by when it merged.
      </div>
    </div>
  );
}
