import type { AnalyticsTokenTotals } from "@open-inspect/shared/types/analytics";
import { formatAnalyticsCount } from "@/lib/analytics";

const TOKEN_FIELDS = [
  ["inputTokens", "Input"],
  ["outputTokens", "Output"],
  ["cacheReadTokens", "Cache read"],
  ["cacheWriteTokens", "Cache write"],
  ["reasoningTokens", "Reasoning (OpenCode only)"],
] as const;

export function AnalyticsTokenTotals({ totals }: { totals: AnalyticsTokenTotals }) {
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm sm:grid-cols-3 lg:grid-cols-5">
      {TOKEN_FIELDS.map(([field, label]) => (
        <div key={field}>
          <dt className="text-xs text-muted-foreground">{label}</dt>
          <dd className="tabular-nums">{formatAnalyticsCount(totals[field])}</dd>
        </div>
      ))}
    </dl>
  );
}
