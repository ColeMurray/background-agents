import { createModels, type Models } from "@earendil-works/pi-ai/models";
import { calculateCost } from "@earendil-works/pi-ai/models";
import {
  costAtPrice,
  type HarnessModelPrice,
  type HarnessPriceTable,
  type HarnessUsage,
} from "../harness/pricing";
import { toPiModel } from "./runtime-contract";

/**
 * The Pi harness's price table.
 *
 * The prices come from the model catalogue the package ships, which the server
 * holds; the arithmetic is the catalogue's own, so a tiered model is priced
 * by its own tiers. The contract — *what* a harness must be able to answer
 * about cost — is the harness-neutral one in `harness/pricing.ts`; this is
 * only how the Pi adapter answers it.
 */
export function createPiPriceTable(models: Models = createModels()): HarnessPriceTable {
  return {
    priceFor(modelId: string): HarnessModelPrice | null {
      const reference = toPiModel(modelId);
      const model = models.getModel(reference.provider, reference.id);
      if (!model) return null;
      return {
        input: model.cost.input,
        output: model.cost.output,
        cacheRead: model.cost.cacheRead,
        cacheWrite: model.cost.cacheWrite,
      };
    },
    costOf(modelId: string, usage: HarnessUsage): number {
      const reference = toPiModel(modelId);
      const model = models.getModel(reference.provider, reference.id);
      if (!model) throw new Error(`Pi model ${modelId} has no trusted server pricing`);
      // The catalogue prices a model with tiers by its own tiers, so the
      // catalogue does the arithmetic when it has them.
      const tiers = model.cost.tiers;
      if (tiers && tiers.length > 0) {
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
      const price = model.cost;
      return costAtPrice(
        {
          input: price.input,
          output: price.output,
          cacheRead: price.cacheRead,
          cacheWrite: price.cacheWrite,
        },
        usage
      );
    },
  };
}
