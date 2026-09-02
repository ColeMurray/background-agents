export interface BudgetEvaluationInput {
  totalCost: number;
  maxCostUsd: number | null;
  warningThresholdPct: number;
  warningSent: boolean;
  exhausted: boolean;
}

export type BudgetAction = "none" | "warn" | "exhaust";

export function evaluateBudget(input: BudgetEvaluationInput): BudgetAction {
  if (input.maxCostUsd === null) return "none";
  if (input.totalCost >= input.maxCostUsd) {
    return input.exhausted ? "none" : "exhaust";
  }
  if (
    !input.warningSent &&
    !input.exhausted &&
    input.totalCost >= (input.maxCostUsd * input.warningThresholdPct) / 100
  ) {
    return "warn";
  }
  return "none";
}

export function hasPositiveTokenUsage(tokens: unknown): boolean {
  if (!tokens || typeof tokens !== "object" || Array.isArray(tokens)) return false;

  const usage = tokens as Record<string, unknown>;
  if ([usage.total, usage.input, usage.output, usage.reasoning].some(isPositiveNumber)) return true;

  const cache = usage.cache;
  return (
    !!cache &&
    typeof cache === "object" &&
    !Array.isArray(cache) &&
    [(cache as Record<string, unknown>).read, (cache as Record<string, unknown>).write].some(
      isPositiveNumber
    )
  );
}

function isPositiveNumber(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
