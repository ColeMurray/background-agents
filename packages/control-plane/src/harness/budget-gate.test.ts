import { describe, expect, it, vi } from "vitest";
import { createBudgetGateProvider, type HarnessBudgetState } from "./budget-gate";

/**
 * The budget is checked before every model call.
 *
 * The wrapper is the only place every model call passes through, so it is the
 * only place the limit can be enforced *before* the money is spent.
 */
describe("the budget gate", () => {
  function provider() {
    return {
      id: "test",
      name: "Test",
      stream: vi.fn(async () => "streamed"),
      streamSimple: vi.fn(async () => "simple"),
    };
  }

  it("lets the call through while the budget holds", async () => {
    const read = vi.fn(async (): Promise<HarnessBudgetState> => ({
      exhausted: false,
      spentUsd: 1,
      capUsd: 10,
    }));
    const gated = createBudgetGateProvider(provider(), read);

    await expect(gated.streamSimple()).resolves.toBe("simple");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("refuses the call once the limit is reached", async () => {
    const read = vi.fn(async (): Promise<HarnessBudgetState> => ({
      exhausted: true,
      spentUsd: 10,
      capUsd: 10,
    }));
    const gated = createBudgetGateProvider(provider(), read);

    await expect(gated.streamSimple()).rejects.toThrow("cost limit");
    await expect(gated.stream()).rejects.toThrow("cost limit");
  });

  it("asks the budget before every call, not once", async () => {
    const read = vi.fn(async (): Promise<HarnessBudgetState> => ({
      exhausted: false,
      spentUsd: 0,
      capUsd: null,
    }));
    const gated = createBudgetGateProvider(provider(), read);

    await gated.streamSimple();
    await gated.streamSimple();
    await gated.streamSimple();

    expect(read).toHaveBeenCalledTimes(3);
  });

  it("keeps the provider's own behaviour", async () => {
    const read = vi.fn(async (): Promise<HarnessBudgetState> => ({
      exhausted: false,
      spentUsd: 0,
      capUsd: null,
    }));
    const original = provider();
    const gated = createBudgetGateProvider(original, read);

    await gated.stream();

    expect(original.stream).toHaveBeenCalledTimes(1);
    expect(gated.id).toBe("test");
  });
});
