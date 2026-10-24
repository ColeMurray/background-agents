/**
 * Server-side pricing, and the usage it is computed from.
 *
 * The control plane has no price table of its own: it trusts the cost the
 * runtime reports. For a harness that runs inside a sandbox, that is a number
 * the agent's own process produced. For a harness with no sandbox it is a
 * number with no cheaper provenance at all.
 *
 * So the cost is computed **here**, on the server, from a price the server
 * holds and usage the server measured. A harness that cannot price its model
 * does not run: the absence of a price is a refusal, not a zero.
 *
 * This module is the harness-neutral contract. It names no harness, and it
 * imports no harness's libraries.
 */

/** The usage a turn consumed, as the server measured it. */
export interface HarnessUsage {
  readonly input: number;
  readonly output: number;
  readonly reasoning?: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly total: number;
}

/**
 * A price table the server holds.
 *
 * The rates are per million tokens. A model the table does not price has no
 * entry, and a turn that uses one is refused.
 */
export interface HarnessModelPrice {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
}

/** What a harness must be able to answer about its own models. */
export interface HarnessPriceTable {
  /** The price of one model, or null when the server does not price it. */
  priceFor(modelId: string): HarnessModelPrice | null;
  /** The cost of a usage, in US dollars. */
  costOf(modelId: string, usage: HarnessUsage): number;
}

/** Whether the table prices this model at all. */
export function hasTrustedPrice(table: HarnessPriceTable, modelId: string): boolean {
  const price = table.priceFor(modelId);
  if (!price) return false;
  return [price.input, price.output, price.cacheRead, price.cacheWrite].some(
    (rate) => Number.isFinite(rate) && rate > 0
  );
}

/**
 * The cost of a usage at a price.
 *
 * A simple table has no tiers, so every token is charged at the model's own
 * rate. A table with tiers answers for itself.
 */
export function costAtPrice(price: HarnessModelPrice, usage: HarnessUsage): number {
  const perMillion = (tokens: number, rate: number) => (tokens / 1_000_000) * rate;
  const cost =
    perMillion(usage.input, price.input) +
    perMillion(usage.output, price.output) +
    perMillion(usage.cacheRead, price.cacheRead) +
    perMillion(usage.cacheWrite, price.cacheWrite);
  if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid usage cost");
  return cost;
}
