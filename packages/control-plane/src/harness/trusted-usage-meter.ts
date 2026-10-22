import { z } from "zod";
import type { UsageAccountingSnapshot } from "./accounting";
import type { HarnessPriceTable, HarnessUsage } from "./pricing";

const METER_KEY = "open-inspect:trusted-usage-meter";
const meterStateSchema = z.object({
  version: z.literal(1),
  usage: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    reasoning: z.number().nonnegative().optional(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
  costUsd: z.number().nonnegative(),
});
type MeterState = z.infer<typeof meterStateSchema>;

export interface TrustedUsageStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
}

/** Durable, server-priced usage for every provider call made by one harness. */
export class TrustedUsageMeter {
  private readonly state: Promise<MeterState>;
  private tail: Promise<void> = Promise.resolve();

  constructor(
    storage: TrustedUsageStorage,
    private readonly prices: HarnessPriceTable
  ) {
    this.storage = storage;
    this.state = storage.get<unknown>(METER_KEY).then((stored) =>
      stored === undefined
        ? {
            version: 1,
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            costUsd: 0,
          }
        : meterStateSchema.parse(stored)
    );
  }

  private readonly storage: TrustedUsageStorage;

  record(modelId: string, usage: HarnessUsage): Promise<void> {
    const update = this.tail.then(async () => {
      const state = await this.state;
      state.usage.input += usage.input;
      state.usage.output += usage.output;
      state.usage.cacheRead += usage.cacheRead;
      state.usage.cacheWrite += usage.cacheWrite;
      state.usage.total += usage.total;
      if (usage.reasoning !== undefined) {
        state.usage.reasoning = (state.usage.reasoning ?? 0) + usage.reasoning;
      }
      state.costUsd += this.prices.costOf(modelId, usage);
      await this.storage.put(METER_KEY, state);
    });
    this.tail = update.catch(() => undefined);
    return update;
  }

  async snapshot(): Promise<UsageAccountingSnapshot> {
    await this.tail;
    const state = await this.state;
    return structuredClone({ usage: state.usage, costUsd: state.costUsd });
  }
}
