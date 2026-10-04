import { afterEach, expect, it, vi } from "vitest";
import { cookies, headers } from "next/headers";
import { dispatchControlPlaneFetch } from "@/lib/control-plane-transport";

vi.mock("next/headers", () => ({ cookies: vi.fn(), headers: vi.fn() }));
vi.mock("@/lib/server-auth-session", () => ({
  getServerAuthSession: vi.fn(async () => ({ user: { id: "test-user" } })),
}));

import { GET } from "./route";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it("streams a run past the transport deadline without interrupting its body", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("CONTROL_PLANE_URL", "https://cp.test");
  vi.stubEnv("SERVICE_AUTH_SECRET", "test-secret");
  vi.mocked(headers).mockResolvedValue(new Headers());
  vi.mocked(cookies).mockResolvedValue({
    getAll: () => [{ name: "openinspect.session_token", value: "test-token" }],
  } as never);

  // Node's native timeout uses real time; exercise its signal on the test clock.
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });

  const encoder = new TextEncoder();
  vi.stubGlobal(
    "fetch",
    vi.fn((_url: string, init: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          setTimeout(() => controller.enqueue(encoder.encode('{"id":"root"}\n')), 9_000);
          const childTimer = setTimeout(() => {
            controller.enqueue(encoder.encode('{"id":"child"}\n'));
            controller.close();
          }, 18_000);
          init.signal?.addEventListener("abort", () => {
            clearTimeout(childTimer);
            controller.error(init.signal?.reason);
          });
        },
      });
      return Promise.resolve(
        new Response(body, { headers: { "Content-Type": "application/x-ndjson" } })
      );
    })
  );

  const response = await GET(
    new Request("https://web.test/api/sessions/session-1/export?scope=runs"),
    { params: Promise.resolve({ id: "session-1" }) }
  );
  const download = response.text().catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(18_000);

  expect(response.status).toBe(200);
  await expect(download).resolves.toBe('{"id":"root"}\n{"id":"child"}\n');
});

it("still times out a streamed request before its response headers", async () => {
  vi.useFakeTimers();
  vi.stubEnv("NODE_ENV", "development");
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        })
    )
  );

  const pending = dispatchControlPlaneFetch(
    "https://cp.test/sessions/session-1/export",
    {},
    {},
    true
  );
  const outcome = pending.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(await outcome).toMatchObject({ name: "TimeoutError" });
});
