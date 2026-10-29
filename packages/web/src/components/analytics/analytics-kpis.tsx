import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface AnalyticsKpiItem {
  label: string;
  value: string;
  detail?: ReactNode;
  /** Daily values drawn as a sparkline under the figure. */
  trend?: number[];
  /** A 0–1 ratio drawn as a meter under the figure. */
  ratio?: number | null;
}

export interface AnalyticsKpiGroup {
  caption: string;
  items: AnalyticsKpiItem[];
}

const COLUMNS: Record<number, string> = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-2 md:grid-cols-4",
  5: "grid-cols-2 md:grid-cols-3 xl:grid-cols-5",
  6: "grid-cols-2 md:grid-cols-3 xl:grid-cols-6",
};

/** Stat cells in one frame, divided by hairlines rather than drawn as separate cards. */
export function AnalyticsKpiStrip({ items }: { items: AnalyticsKpiItem[] }) {
  return (
    <div
      className={cn(
        "grid gap-px overflow-hidden rounded-lg border border-border-muted bg-border-muted",
        COLUMNS[Math.min(items.length, 6)]
      )}
    >
      {items.map((item) => (
        <AnalyticsKpi key={item.label} {...item} />
      ))}
    </div>
  );
}

/**
 * Strips grouped by what they describe. Captions such as "Human sessions" and
 * "Pull requests · every source" show which numbers the scope filter applies to.
 */
export function AnalyticsKpiGroups({ groups }: { groups: AnalyticsKpiGroup[] }) {
  return (
    <div
      className="grid gap-4 xl:gap-3 xl:[grid-template-columns:var(--analytics-kpi-groups)]"
      style={
        {
          "--analytics-kpi-groups": groups.map((group) => `${group.items.length}fr`).join(" "),
        } as CSSProperties
      }
    >
      {groups.map((group) => (
        <section key={group.caption} aria-label={group.caption} className="min-w-0">
          <div className="mb-1.5 text-xs font-medium text-muted-foreground">{group.caption}</div>
          <AnalyticsKpiStrip items={group.items} />
        </section>
      ))}
    </div>
  );
}

function AnalyticsKpi({ label, value, detail, trend, ratio }: AnalyticsKpiItem) {
  return (
    <div className="flex min-w-0 flex-col bg-background px-4 py-3.5">
      <div className="truncate text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-foreground">{value}</div>
      {detail ? (
        <div className="mt-0.5 truncate text-xs text-muted-foreground">{detail}</div>
      ) : null}
      {trend ? <AnalyticsSparkline values={trend} className="mt-2" /> : null}
      {ratio !== undefined && ratio !== null ? (
        <AnalyticsMeter ratio={ratio} className="mt-3" />
      ) : null}
    </div>
  );
}

/** A trend line with a soft wash; decorative, since the figure beside it carries the value. */
export function AnalyticsSparkline({
  values,
  height = 28,
  className,
}: {
  values: number[];
  height?: number;
  className?: string;
}) {
  if (values.length < 2) return <div aria-hidden="true" className={className} style={{ height }} />;
  const max = Math.max(...values, 1);
  const step = 100 / (values.length - 1);
  const line = values
    .map((value, index) => {
      const x = (index * step).toFixed(2);
      const y = (24 - (value / max) * 22).toFixed(2);
      return `${index === 0 ? "M" : "L"}${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 24"
      preserveAspectRatio="none"
      aria-hidden="true"
      className={cn("w-full overflow-visible", className)}
      style={{ height }}
    >
      <path d={`${line} L100,24 L0,24 Z`} fill="var(--accent)" fillOpacity={0.1} />
      <path
        d={line}
        fill="none"
        stroke="var(--accent)"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** A ratio against 100%: the accent fill over a lighter step of the same hue. */
export function AnalyticsMeter({ ratio, className }: { ratio: number; className?: string }) {
  return (
    <div
      aria-hidden="true"
      className={cn("h-1.5 overflow-hidden rounded-full bg-accent-muted", className)}
    >
      <div
        className="h-full rounded-full bg-accent"
        style={{ width: `${Math.max(0, Math.min(1, ratio)) * 100}%` }}
      />
    </div>
  );
}
