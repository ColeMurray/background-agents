import { calculateCost, type Models } from "@earendil-works/pi-ai/models";
import type { PiRuntimeUsage } from "./runtime-contract";
import { toPiModel } from "./runtime-contract";

export function hasTrustedPiPricing(models: Models, modelId: string): boolean {
  const reference = toPiModel(modelId);
  const model = models.getModel(reference.provider, reference.id);
  return (
    model !== undefined &&
    [model.cost.input, model.cost.output, model.cost.cacheRead, model.cost.cacheWrite].some(
      (rate) => Number.isFinite(rate) && rate > 0
    )
  );
}

export function calculatePiUsageCost(
  models: Models,
  modelId: string,
  usage: PiRuntimeUsage
): number {
  const reference = toPiModel(modelId);
  const model = models.getModel(reference.provider, reference.id);
  if (!model) throw new Error(`Pi model ${modelId} has no trusted server pricing`);
  return calculateCost(model, {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    ...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
    totalTokens: usage.total,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  }).total;
}
