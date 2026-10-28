import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_AUTH_CALLBACK_TIMEOUT_MS } from "./browser-auth-proxy";
import { dispatchControlPlaneFetch } from "./control-plane-transport";

describe("control-plane transport deadlines", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "development");
    // Native AbortSignal.timeout is not driven by Vitest's clock.
    vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), timeoutMs);
      return controller.signal;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
              once: true,
            });
          })
      )
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  it.each([
    ["ordinary resources", undefined, 15_000],
    ["OAuth callbacks", BROWSER_AUTH_CALLBACK_TIMEOUT_MS, BROWSER_AUTH_CALLBACK_TIMEOUT_MS],
  ] as const)(
    "bounds %s at the exact configured deadline",
    async (_name, timeoutMs, expectedMs) => {
      const request = dispatchControlPlaneFetch(
        "https://control-plane.example/path",
        {},
        {},
        false,
        timeoutMs
      );
      const rejected = expect(request).rejects.toMatchObject({ name: "TimeoutError" });
      await vi.advanceTimersByTimeAsync(expectedMs - 1);
      const signal = vi.mocked(fetch).mock.calls[0]?.[1]?.signal;
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(signal?.aborted).toBe(true);
      await rejected;
    }
  );

  it("preserves caller cancellation with a callback budget", async () => {
    const caller = new AbortController();
    const request = dispatchControlPlaneFetch(
      "https://control-plane.example/api/auth/callback/github",
      { signal: caller.signal },
      {},
      false,
      BROWSER_AUTH_CALLBACK_TIMEOUT_MS
    );
    const rejected = expect(request).rejects.toThrow("Caller disconnected");
    await vi.advanceTimersByTimeAsync(1);
    caller.abort(new Error("Caller disconnected"));
    await rejected;
  });
});
