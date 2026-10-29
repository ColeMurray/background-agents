import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BULK_SKILL_IMPORT_TIMEOUT_MS } from "@/app/api/skills/import/bulk/request-timeout";
import { BROWSER_AUTH_CALLBACK_TIMEOUT_MS } from "./browser-auth-proxy";
import { dispatchControlPlaneFetch } from "./control-plane-transport";

const mocks = vi.hoisted(() => ({
  bindingFetch: vi.fn<typeof fetch>(),
}));

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: async () => ({
    env: { CONTROL_PLANE_WORKER: { fetch: mocks.bindingFetch } },
  }),
}));

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

  it.each(["development", "production"] as const)(
    "allows a slow collection response beyond the default deadline in %s",
    async (mode) => {
      vi.stubEnv("NODE_ENV", mode);
      const slowFetch = (_input: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          setTimeout(() => resolve(Response.json({ skills: [] })), 20_000);
        });
      vi.mocked(fetch).mockImplementation(slowFetch);
      mocks.bindingFetch.mockImplementation(slowFetch);

      const pending = dispatchControlPlaneFetch(
        "https://control-plane.example/skills/import/bulk/preview",
        {},
        {},
        false,
        BULK_SKILL_IMPORT_TIMEOUT_MS
      );
      await vi.advanceTimersByTimeAsync(20_000);

      expect((await pending).status).toBe(200);
      const transport = mode === "production" ? mocks.bindingFetch : vi.mocked(fetch);
      expect(transport).toHaveBeenCalledOnce();
    }
  );
});
