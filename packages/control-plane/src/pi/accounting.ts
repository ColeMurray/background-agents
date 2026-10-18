import type { UsageState } from "@earendil-works/pi-durable";
import type { PiRuntimeUsage } from "./runtime-contract";

export interface PiAccountingSnapshot {
  readonly usage: PiRuntimeUsage;
  readonly costUsd: number;
}

export function summarizePiUsage(state: Readonly<UsageState>): PiAccountingSnapshot {
  const usage: PiRuntimeUsage = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  };
  let costUsd = 0;
  for (const item of [...Object.values(state.models), ...Object.values(state.tools)]) {
    const cost = item.cost;
    if (
      !cost ||
      ![cost.input, cost.output, cost.cacheRead, cost.cacheWrite, cost.total].every(
        (value) => Number.isFinite(value) && value >= 0
      )
    ) {
      throw new Error("Invalid Pi usage cost");
    }
    usage.input += item.input;
    usage.output += item.output;
    usage.cacheRead += item.cacheRead;
    usage.cacheWrite += item.cacheWrite;
    usage.total += item.totalTokens;
    if (item.reasoning !== undefined) usage.reasoning = (usage.reasoning ?? 0) + item.reasoning;
    costUsd += cost.total;
  }
  if (!Number.isFinite(costUsd) || costUsd < 0) throw new Error("Invalid Pi usage cost");
  return { usage, costUsd };
}

export function operationAccountingDelta(
  current: PiAccountingSnapshot,
  baseline: PiAccountingSnapshot
): PiAccountingSnapshot {
  return {
    usage: subtractUsage(current.usage, baseline.usage),
    costUsd: Math.max(0, current.costUsd - baseline.costUsd),
  };
}

function subtractUsage(current: PiRuntimeUsage, baseline: PiRuntimeUsage): PiRuntimeUsage {
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
