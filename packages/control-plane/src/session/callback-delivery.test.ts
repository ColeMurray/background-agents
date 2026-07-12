import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverWithRetry } from "./callback-delivery";

describe("deliverWithRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aborts timed-out attempts before retrying", async () => {
    vi.useFakeTimers();
    const send = vi.fn(
      (signal: AbortSignal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );

    const delivery = deliverWithRetry(send, async () => {}, vi.fn());
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10_000);

    await expect(delivery).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([signal]) => signal instanceof AbortSignal)).toBe(true);
  });
});
