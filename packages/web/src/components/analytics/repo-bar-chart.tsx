import type { TooltipContentProps } from "recharts";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalyticsBreakdownResponse } from "@open-inspect/shared";
import { formatAnalyticsCount } from "@/lib/analytics";
import { formatSessionCost } from "@/lib/session-cost";

interface RepoBarChartProps {
  entries?: AnalyticsBreakdownResponse["entries"];
  loading: boolean;
}

interface RepoChartRow {
  repo: string;
  sessions: number;
  cost: number;
  prs: number;
  messageCount: number;
}

function RepoChartTooltip({ active, payload }: TooltipContentProps) {
  const row = payload?.[0]?.payload as RepoChartRow | undefined;

  if (!active || !row) {
    return null;
  }

  return (
    <div className="min-w-[13rem] rounded-md border border-border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md">
      <div className="font-medium text-foreground">{row.repo}</div>
      <div className="mt-2 grid gap-1.5">
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Sessions</span>
          <span className="font-medium text-foreground">{formatAnalyticsCount(row.sessions)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Cost</span>
          <span className="font-medium text-foreground">{formatSessionCost(row.cost)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">PRs</span>
          <span className="font-medium text-foreground">{formatAnalyticsCount(row.prs)}</span>
        </div>
        <div className="flex items-center justify-between gap-4">
          <span className="text-muted-foreground">Messages</span>
          <span className="font-medium text-foreground">
            {formatAnalyticsCount(row.messageCount)}
          </span>
        </div>
      </div>
    </div>
  );
}

export function AnalyticsRepoBarChart({ entries, loading }: RepoBarChartProps) {
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
        <div className="text-lg font-semibold text-foreground">Sessions by Repository</div>
        <p className="mt-1 text-sm text-muted-foreground">
          No repository data found for this range.
        </p>
      </div>
    );
  }

  const chartHeight = Math.max(260, entries.length * 44);
  const leadRepo = entries.reduce(
    (top, entry) => (entry.sessions > top.sessions ? entry : top),
    entries[0]
  );
  const chartData = entries.map((entry) => ({
    repo: entry.key,
    sessions: entry.sessions,
    cost: entry.cost,
    prs: entry.prs,
    messageCount: entry.messageCount,
  }));

  return (
    <div className="rounded-md border border-border-muted bg-card p-5">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">Sessions by Repository</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Horizontal distribution of session volume across repositories.
          </p>
        </div>
        <div className="grid gap-2 sm:min-w-[15rem] sm:grid-cols-2">
          <div className="rounded-md border border-border-muted bg-background px-3 py-3">
            <div className="text-xs uppercase tracking-wider text-secondary-foreground">
              Tracked repos
            </div>
            <div className="mt-2 text-lg font-semibold text-foreground">
              {formatAnalyticsCount(entries.length)}
            </div>
          </div>
          <div className="rounded-md border border-border-muted bg-background px-3 py-3">
            <div className="text-xs uppercase tracking-wider text-secondary-foreground">
              Top repo
            </div>
            <div className="mt-2 truncate text-sm font-semibold text-foreground">
              {leadRepo.key}
            </div>
            <div className="mt-1 text-xs text-muted-foreground">
              {formatAnalyticsCount(leadRepo.sessions)} sessions
            </div>
          </div>
        </div>
      </div>

      <div className="mt-6 max-h-[420px] overflow-y-auto rounded-lg border border-border-muted bg-background p-3 pr-2 sm:p-4">
        <div style={{ height: chartHeight }}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              layout="vertical"
              margin={{ top: 8, right: 12, left: 12, bottom: 0 }}
            >
              <CartesianGrid stroke="var(--border)" horizontal={false} />
              <XAxis
                type="number"
                allowDecimals={false}
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--muted-foreground)", fontSize: 12 }}
              />
              <YAxis
                type="category"
                dataKey="repo"
                width={180}
                axisLine={false}
                tickLine={false}
                tick={{ fill: "var(--foreground)", fontSize: 12 }}
              />
              <Tooltip
                cursor={{ fill: "var(--accent-muted)" }}
                content={(props) => <RepoChartTooltip {...props} />}
              />
              <Bar dataKey="sessions" fill="var(--accent)" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="mt-3 text-xs text-muted-foreground">
        The bars reflect session volume, and hover details include cost, PR totals, and messages.
      </div>
    </div>
  );
}
