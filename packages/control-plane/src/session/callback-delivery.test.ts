import { afterEach, describe, expect, it, vi } from "vitest";
import { deliverWithRetry } from "./callback-delivery";

describe("deliverWithRetry", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns delivery aggregates without retrying after a successful response", async () => {
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const onFailure = vi.fn();

    await expect(deliverWithRetry(send, vi.fn(), onFailure)).resolves.toEqual({
      delivered: true,
      attempts: 1,
      httpStatus: 204,
    });
    expect(send).toHaveBeenCalledOnce();
    expect(onFailure).not.toHaveBeenCalled();
  });

  it("retries non-OK responses before returning failure aggregates", async () => {
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const sleep = vi.fn();
    const onFailure = vi.fn();

    await expect(deliverWithRetry(send, sleep, onFailure)).resolves.toEqual({
      delivered: false,
      attempts: 2,
      httpStatus: 503,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect(onFailure).toHaveBeenCalledTimes(2);
  });

  it("continues retrying when the failure observer throws", async () => {
    const send = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    const onFailure = vi.fn(() => {
      throw new Error("observer unavailable");
    });

    await expect(deliverWithRetry(send, vi.fn(), onFailure)).resolves.toEqual({
      delivered: false,
      attempts: 2,
      httpStatus: 503,
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(2);
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

    await expect(delivery).resolves.toEqual({ delivered: false, attempts: 2 });
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls.every(([signal]) => signal instanceof AbortSignal)).toBe(true);
  });

  it("does not retain an HTTP status when the final attempt throws", async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("network error"));

    await expect(deliverWithRetry(send, vi.fn(), vi.fn())).resolves.toEqual({
      delivered: false,
      attempts: 2,
    });
  });
});
