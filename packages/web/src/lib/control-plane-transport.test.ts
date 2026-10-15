import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bindingFetch: vi.fn(),
  getCloudflareContext: vi.fn(),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: mocks.getCloudflareContext,
}));

import { dispatchControlPlaneFetch } from "./control-plane-transport";

describe("dispatchControlPlaneFetch", () => {
  const originalEnv = { ...process.env };
  const directFetch = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("fetch", directFetch);
    directFetch.mockResolvedValue(Response.json({ ok: true }));
    mocks.bindingFetch.mockResolvedValue(Response.json({ ok: true }));
    mocks.getCloudflareContext.mockResolvedValue({
      env: { CONTROL_PLANE_WORKER: { fetch: mocks.bindingFetch } },
    });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("uses the default timeout for direct fetches", async () => {
    process.env = { ...originalEnv, NODE_ENV: "development" };
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);

    await dispatchControlPlaneFetch("https://control-plane.example/settings", {}, {});

    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
    expect(directFetch).toHaveBeenCalledWith(
      "https://control-plane.example/settings",
      expect.objectContaining({ signal: timeout.signal })
    );
    expect(mocks.bindingFetch).not.toHaveBeenCalled();
  });

  it("uses a route-specific timeout for Cloudflare service bindings", async () => {
    process.env = { ...originalEnv, NODE_ENV: "production" };
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);

    await dispatchControlPlaneFetch(
      "https://control-plane.example/skills/import/bulk/preview",
      { method: "POST" },
      {},
      false,
      120_000
    );

    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    expect(mocks.bindingFetch).toHaveBeenCalledWith(
      "https://control-plane.example/skills/import/bulk/preview",
      expect.objectContaining({ method: "POST", signal: timeout.signal })
    );
    expect(directFetch).not.toHaveBeenCalled();
  });

  it("preserves caller cancellation with a route-specific timeout", async () => {
    process.env = { ...originalEnv, NODE_ENV: "production" };
    const caller = new AbortController();
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);

    await dispatchControlPlaneFetch(
      "https://control-plane.example/skills/import/bulk",
      { signal: caller.signal },
      {},
      false,
      120_000
    );

    const forwardedSignal = mocks.bindingFetch.mock.calls[0]?.[1]?.signal;
    expect(forwardedSignal).toBeInstanceOf(AbortSignal);
    expect(forwardedSignal).not.toBe(caller.signal);
    expect(forwardedSignal?.aborted).toBe(false);

    caller.abort("caller disconnected");

    expect(forwardedSignal?.aborted).toBe(true);
    expect(forwardedSignal?.reason).toBe("caller disconnected");
  });
  it.each(["development", "production"] as const)(
    "allows a slow collection response beyond the default deadline in %s",
    async (mode) => {
      process.env = { ...originalEnv, NODE_ENV: mode };
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException("Timed out", "TimeoutError")),
          timeoutMs
        );
        return controller.signal;
      });
      const slowFetch = (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          setTimeout(() => resolve(Response.json({ skills: [] })), 20_000);
        });
      directFetch.mockImplementation(slowFetch);
      mocks.bindingFetch.mockImplementation(slowFetch);
      try {
        const pending = dispatchControlPlaneFetch(
          "https://control-plane.example/skills/import/bulk/preview",
          {},
          {},
          false,
          120_000
        );
        await vi.advanceTimersByTimeAsync(20_000);
        expect((await pending).status).toBe(200);
      } finally {
        vi.useRealTimers();
      }
    }
  );
});
