import { afterEach, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";
import { dispatchControlPlaneFetch } from "@/lib/control-plane-transport";
import { createLogger } from "@/lib/logger";

// Load the real worker implementation at runtime without pulling worker-only
// environment types into the web application's TypeScript compilation.
const batchModulePath = new URL(
  "../../../../../../control-plane/src/session/batch-archive.ts",
  import.meta.url
).pathname;
const { archiveSessionBatch } = await import(batchModulePath);

vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(async () => ({ user: { id: "test-user" } })),
}));
vi.mock("@/lib/control-plane", () => ({
  controlPlaneUserFetch: (path: string, options: RequestInit) =>
    dispatchControlPlaneFetch(`https://cp.test${path}`, options, {}),
}));
import { POST } from "./route";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("returns ordered partial outcomes for a maximum slow batch before the proxy deadline", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "development");
  // Node's native AbortSignal timer is not fake-clock aware; retain its exact
  // production timeout arguments while delivering expiry through Vitest's clock.
  const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  let completed = 0;
  let serverResult: Promise<unknown>;
  const runtime = {
    fetch: async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 9_000));
      completed++;
      return Response.json({ outcome: "archived" });
    },
  };
  vi.stubGlobal("fetch", (_url: string, options: RequestInit) => {
    serverResult = archiveSessionBatch(
      Array.from({ length: 25 }, (_, i) => `session-${i}`),
      runtime,
      createLogger("diagnostic")
    );
    return new Promise<Response>((resolve, reject) => {
      options.signal!.addEventListener("abort", () => reject(options.signal!.reason));
      serverResult.then((results) => resolve(Response.json({ results })));
    });
  });
  const pending = POST(
    new Request("https://web.test/api/sessions/batch-archive", {
      method: "POST",
      body: JSON.stringify({ sessionIds: Array.from({ length: 25 }, (_, i) => `session-${i}`) }),
    }) as NextRequest
  );
  await vi.advanceTimersByTimeAsync(10_000);
  const response = await pending;
  expect(timeout).toHaveBeenCalledWith(15_000);
  expect(timeout).toHaveBeenCalledWith(10_000);
  expect(completed).toBe(5);
  expect(response.status).toBe(200);
  const expected = Array.from({ length: 25 }, (_, i) => ({
    sessionId: `session-${i}`,
    outcome: i < 5 ? "archived" : "failed",
  }));
  expect(await response.json()).toEqual({ results: expected });
  // A transport ignoring abort may finish dispatched writes; those IDs remain
  // safely retryable, and the fifteen unstarted targets were never dispatched.
  await vi.advanceTimersByTimeAsync(8_000);
  expect(await serverResult!).toEqual(expected);
  expect(completed).toBe(10);
});
