import type { TooltipContentProps } from "recharts";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  getCacheHitRatio,
  type AnalyticsBreakdownResponse,
} from "@open-inspect/shared/types/analytics";
import { formatAnalyticsCount, formatAnalyticsRatio } from "@/lib/analytics";
import { formatSessionCost } from "@/lib/session-cost";

interface ModelBarChartProps {
  entries?: AnalyticsBreakdownResponse["entries"];
  loading: boolean;
}

interface ModelChartRow {
  model: string;
  name: string;
  key: string;
  sessions: number;
  cost: number;
  prs: number;
  cacheHitRatio: number | null;
}

function ModelChartTooltip({ active, payload }: TooltipContentProps) {
  const row = payload?.[0]?.payload as ModelChartRow | undefined;
  if (!active || !row) return null;

  return (
    <div className="min-w-[13rem] rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium text-foreground">{row.name}</div>
      {row.key !== row.name ? <div className="mt-1 text-muted-foreground">{row.key}</div> : null}
      <div className="mt-2 grid gap-1.5">
        {[
          ["Sessions", formatAnalyticsCount(row.sessions)],
          ["Cost", formatSessionCost(row.cost)],
          ["PRs", formatAnalyticsCount(row.prs)],
          ["Cache hit ratio", formatAnalyticsRatio(row.cacheHitRatio)],
        ].map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-4">
            <span className="text-muted-foreground">{label}</span>
            <span className="font-medium text-foreground">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function AnalyticsModelBarChart({ entries, loading }: ModelBarChartProps) {
  if (loading && !entries) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5 animate-pulse">
        <div className="h-4 w-44 rounded bg-muted" />
        <div className="mt-2 h-4 w-64 rounded bg-muted" />
        <div className="mt-6 h-[320px] rounded bg-muted" />
      </div>
    );
  }

  if (!entries?.length) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5">
        <div className="text-lg font-semibold text-foreground">Cost by Model</div>
        <p className="mt-1 text-sm text-muted-foreground">No model data found for this range.</p>
      </div>
    );
  }

  const nameCounts = new Map<string, number>();
  for (const entry of entries) {
    const name = entry.displayName ?? entry.key;
    nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  }
  const chartData: ModelChartRow[] = [...entries]
    .sort((left, right) => right.cost - left.cost)
    .map((entry) => {
      const name = entry.displayName ?? entry.key;
      return {
        model: (nameCounts.get(name) ?? 0) > 1 ? entry.key : name,
        name,
        key: entry.key,
        sessions: entry.sessions,
        cost: entry.cost,
        prs: entry.prs,
        cacheHitRatio: getCacheHitRatio(entry),
      };
    });

  return (
    <div className="rounded-md border border-border-muted bg-card p-5">
      <h2 className="text-lg font-semibold text-foreground">Cost by Model</h2>
      <p className="mt-1 text-sm text-muted-foreground">
        Session cost across models in the selected scope.
      </p>
      <div className="mt-6 max-h-[420px] overflow-y-auto rounded-lg border border-border-muted bg-background p-3 pr-2 sm:p-4">
        <div style={{ height: Math.max(260, entries.length * 44) }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 8, right: 12, left: 12, bottom: 0 }}
            >
              <CartesianGrid stroke="var(--border)" horizontal={false} />
              <XAxis
                type="number"
                axisLine={false}
                tickLine={false}
                tickFormatter={formatSessionCost}
                tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              />
              <YAxis
                type="category"
                dataKey="model"
                width={180}
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--foreground)", fontSize: 12 }}
              />
              <Tooltip
                cursor={{ fill: "var(--accent-muted)" }}
                content={(props) => <ModelChartTooltip {...props} />}
              />
              <Bar dataKey="cost" fill="var(--accent)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
