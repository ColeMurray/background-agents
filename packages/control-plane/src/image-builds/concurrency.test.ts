import { describe, expect, it, vi } from "vitest";
import { runMaintenanceTasks } from "./concurrency";

describe("runMaintenanceTasks", () => {
  it("attempts every task before surfacing the first failure", async () => {
    const attempted: number[] = [];
    let inFlight = 0;
    let peakInFlight = 0;
    const task = vi.fn(async (item: number) => {
      attempted.push(item);
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      if (item < 4) throw new Error(`failed-${item}`);
    });

    await expect(
      runMaintenanceTasks(
        Array.from({ length: 12 }, (_, index) => index),
        task
      )
    ).rejects.toThrow("failed-0");

    expect(attempted.sort((left, right) => left - right)).toEqual(
      Array.from({ length: 12 }, (_, index) => index)
    );
    expect(peakInFlight).toBeLessThanOrEqual(4);
  });
});
