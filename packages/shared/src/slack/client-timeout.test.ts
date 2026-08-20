import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getExternalUploadUrl,
  getThreadMessages,
  getUserInfo,
  listChannels,
  postMessage,
  SLACK_PAGINATION_TIMEOUT_MS,
  SLACK_REQUEST_TIMEOUT_MS,
} from "./client";

function stalledFetch() {
  return vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => {
    return new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    });
  });
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
  });
}

describe("Slack request deadlines", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts a stalled read at the shared request deadline", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    stalledFetch();

    const resultPromise = getUserInfo("xoxb-token", "U1");
    timeout.abort(new DOMException("deadline exceeded", "TimeoutError"));

    await expect(resultPromise).resolves.toEqual({ ok: false, error: "timeout" });
    expect(timeoutSpy).toHaveBeenCalledWith(SLACK_REQUEST_TIMEOUT_MS);
  });

  it("marks a timed-out write as having unknown delivery", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    stalledFetch();

    const resultPromise = postMessage("xoxb-token", "C123", "hi");
    timeout.abort(new DOMException("deadline exceeded", "TimeoutError"));

    await expect(resultPromise).resolves.toEqual({ ok: false, error: "delivery_unknown" });
  });

  it("combines caller cancellation with the shared request deadline", async () => {
    const timeout = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    const caller = new AbortController();
    const fetchSpy = stalledFetch();

    const resultPromise = getExternalUploadUrl("xoxb-token", {
      filename: "chart.png",
      length: 1234,
      signal: caller.signal,
    });
    caller.abort();

    await expect(resultPromise).resolves.toEqual({ ok: false, error: "cancelled" });
    expect(fetchSpy.mock.calls[0]![1]?.signal).not.toBe(caller.signal);
    expect(timeout.signal.aborted).toBe(false);
  });
});

describe("Slack pagination deadlines", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("bounds the aggregate duration across channel pages", async () => {
    const paginationTimeout = new AbortController();
    const requestTimeouts: AbortController[] = [];
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((timeoutMs) => {
      if (timeoutMs === SLACK_PAGINATION_TIMEOUT_MS) return paginationTimeout.signal;
      const requestTimeout = new AbortController();
      requestTimeouts.push(requestTimeout);
      return requestTimeout.signal;
    });
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          channels: [{ id: "C1", name: "a" }],
          response_metadata: { next_cursor: "cur-2" },
        })
      )
      .mockImplementationOnce((_url, init) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
            once: true,
          });
        });
      });

    const resultPromise = listChannels("xoxb-token");
    await vi.waitFor(() => expect(requestTimeouts).toHaveLength(2));
    paginationTimeout.abort(new DOMException("pagination deadline exceeded", "TimeoutError"));

    await expect(resultPromise).resolves.toEqual({ ok: false, error: "timeout" });
    expect(timeoutSpy).toHaveBeenCalledWith(SLACK_PAGINATION_TIMEOUT_MS);
    expect(requestTimeouts.every((controller) => !controller.signal.aborted)).toBe(true);
  });

  it("combines caller cancellation with the thread pagination deadline", async () => {
    const caller = new AbortController();
    stalledFetch();

    const resultPromise = getThreadMessages("xoxb-token", "C123", "1.0", undefined, {
      signal: caller.signal,
    });
    caller.abort();

    await expect(resultPromise).resolves.toEqual({ ok: false, error: "cancelled" });
  });
});
