import type { HarnessUsage } from "./pricing";

/**
 * Usage, as a runtime reports it.
 *
 * The seam sums what a turn used and what it cost. It does not know which
 * runtime reported it, so it reads its own shape and the adapter maps the
 * runtime's shape onto it.
 */

/** What one model or tool call used. */
export interface HarnessUsageEntry {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly totalTokens: number;
  readonly reasoning?: number;
  readonly cost?: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

/** What a turn used, by model and by tool. */
export interface HarnessUsageState {
  readonly models: Readonly<Record<string, HarnessUsageEntry>>;
  readonly tools: Readonly<Record<string, HarnessUsageEntry>>;
}

export interface UsageAccountingSnapshot {
  readonly usage: HarnessUsage;
  readonly costUsd: number;
}

/** The cost and the usage of a turn, from what it used. */
export function summarizeUsage(state: Readonly<HarnessUsageState>): UsageAccountingSnapshot {
  const usage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  } as { -readonly [K in keyof HarnessUsage]: HarnessUsage[K] };
  let costUsd = 0;
  for (const item of [...Object.values(state.models), ...Object.values(state.tools)]) {
    const cost = item.cost;
    if (
      !cost ||
      ![cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(
        (value) => Number.isFinite(value) && value >= 0
      )
    ) {
      throw new Error("Invalid usage cost");
    }
    usage.input += item.input;
    usage.output += item.output;
    usage.cacheRead += item.cacheRead;
    usage.cacheWrite += item.cacheWrite;
    usage.total += item.totalTokens;
    if (item.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + item.reasoning;
    costUsd += cost.total;
  }
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Invalid usage cost");
  return { usage, costUsd };
}

export function accountingDelta(
  current: UsageAccountingSnapshot,
  baseline: UsageAccountingSnapshot
): UsageAccountingSnapshot {
  return {
    usage: subtractUsage(current.usage, baseline.usage),
    costUsd: Math.max(0, current.costUsd - baseline.costUsd),
  };
}

function subtractUsage(current: HarnessUsage, baseline: HarnessUsage): HarnessUsage {
  return {
    input: Math.max(0, current.input - baseline.input),
    output: Math.max(0, current.output - baseline.output),
    cacheRead: Math.max(0, current.cacheRead - baseline.cacheRead),
    cacheWrite: Math.max(0, current.cacheWrite - baseline.cacheWrite),
    total: Math.max(0, current.total - baseline.total),
    ...(current.reasoning === undefined && baseline.reasoning === undefined
      ? {}
      : { reasoning: Math.max(0, (current.reasoning ?? 0) - (baseline.reasoning ?? 0)) }),
  };
}
