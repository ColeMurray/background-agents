import {
  getCacheHitRatio,
  type AnalyticsSummaryResponse,
} from "@open-inspect/shared/types/analytics";
import { formatAnalyticsCount, formatAnalyticsRatio } from "@/lib/analytics";
import { SummaryCard } from "./summary-cards";

interface TokenCardsProps {
  summary?: AnalyticsSummaryResponse;
  loading: boolean;
}

export function AnalyticsTokenCards({ summary, loading }: TokenCardsProps) {
  if (loading && !summary) {
    return (
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 4 }).map((_, index) => (
          <div
            key={index}
            className="rounded-md border border-border-muted bg-card p-4 animate-pulse"
          >
            <div className="h-3 w-24 rounded bg-muted" />
            <div className="mt-4 h-7 w-20 rounded bg-muted" />
            <div className="mt-3 h-4 w-32 rounded bg-muted" />
          </div>
        ))}
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="rounded-md border border-border-muted bg-card p-5">
        <div className="text-lg font-semibold text-foreground">Token Usage</div>
        <p className="mt-1 text-sm text-muted-foreground">No token data found for this range.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <SummaryCard
          label="Input tokens"
          value={formatAnalyticsCount(summary.inputTokens)}
          hint="Model input"
        />
        <SummaryCard
          label="Output tokens"
          value={formatAnalyticsCount(summary.outputTokens)}
          hint="Model output"
        />
        <SummaryCard
          label="Cache hit ratio"
          value={formatAnalyticsRatio(getCacheHitRatio(summary))}
          hint="cache reads ÷ (cache reads + input)"
        />
        <SummaryCard
          label="Reasoning tokens"
          value={formatAnalyticsCount(summary.reasoningTokens)}
          hint="reported by OpenCode only"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Token totals cover sessions created since token capture was enabled; older sessions count as
        zero.
      </p>
    </div>
  );
}
