import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SANDBOX0_REQUEST_TIMEOUT_MS,
  Sandbox0ApiError,
  Sandbox0RestClient,
  sandbox0Path,
} from "./sandbox0-rest-client";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("Sandbox0RestClient", () => {
  it.each([undefined, 25])("aborts at the configured request deadline (%s)", async (timeoutMs) => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            requestSignal = init.signal!;
            requestSignal.addEventListener("abort", () => reject(requestSignal!.reason), {
              once: true,
            });
          })
      )
    );
    const deadlineMs = timeoutMs ?? DEFAULT_SANDBOX0_REQUEST_TIMEOUT_MS;
    const assertion = expect(
      new Sandbox0RestClient({ apiKey: "secret" }).request("GET", "/test", undefined, { timeoutMs })
    ).rejects.toMatchObject({ name: "RequestDeadlineError", timeoutMs: deadlineMs });
    await vi.advanceTimersByTimeAsync(deadlineMs - 1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });
  it("uses bearer auth, JSON and an idempotency header without following redirects", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ data: { id: "created" } }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new Sandbox0RestClient({ apiKey: "secret" });
    await expect(
      client.request("POST", "/api/v1/sandboxes", { template: "oi" }, { idempotencyKey: "attempt" })
    ).resolves.toEqual({ id: "created" });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.sandbox0.ai/api/v1/sandboxes",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        body: '{"template":"oi"}',
        headers: {
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          "Idempotency-Key": "attempt",
        },
      })
    );
  });
  it.each([401, 404, 409, 429, 503])(
    "preserves HTTP %s without leaking error bodies",
    async (status) => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(new Response("private customer data", { status }))
      );
      const error = await new Sandbox0RestClient({ apiKey: "secret" })
        .request("GET", "/test")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(Sandbox0ApiError);
      expect(error).toMatchObject({ status });
      expect(String(error)).not.toContain("private customer data");
    }
  );
  it("rejects a malformed successful envelope", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));
    await expect(
      new Sandbox0RestClient({ apiKey: "secret" }).request("GET", "/test")
    ).rejects.toThrow("returned no data");
  });
  it.each([
    "http://example.com",
    "https://user:pass@example.com",
    "https://example.com?key=secret",
    "https://example.com#fragment",
  ])("rejects unsafe endpoint %s", (apiUrl) => {
    expect(() => new Sandbox0RestClient({ apiKey: "secret", apiUrl })).toThrow();
  });
  it("allows loopback HTTP for isolated testing and encodes resource identifiers", () => {
    expect(
      () => new Sandbox0RestClient({ apiKey: "secret", apiUrl: "http://127.0.0.1:3000" })
    ).not.toThrow();
    expect(sandbox0Path("a/b")).toBe("/api/v1/sandboxes/a%2Fb");
  });
});
