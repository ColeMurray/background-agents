import { afterEach, describe, expect, it, vi } from "vitest";

import { getChannelInfo, postMessage } from "./client";

function jsonResponse(
  body: unknown,
  init: { status?: number; headers?: Record<string, string> } = {}
): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

describe("postMessage", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts text to a channel and returns the Slack envelope", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: "1700000000.000100" }));

    const result = await postMessage("xoxb-token", "C123", "hello");

    expect(result.ok).toBe(true);
    expect(result.ts).toBe("1700000000.000100");
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(init?.method).toBe("POST");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-token");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.channel).toBe("C123");
    expect(body.text).toBe("hello");
  });

  it("threads via thread_ts when provided", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(jsonResponse({ ok: true, ts: "1700000000.000200" }));

    await postMessage("xoxb-token", "C123", "reply text", {
      thread_ts: "1699999999.000100",
    });

    const init = fetchSpy.mock.calls[0]![1];
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body.thread_ts).toBe("1699999999.000100");
  });

  it("returns Slack's error envelope without throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "channel_not_found" })
    );

    const result = await postMessage("xoxb-token", "C404", "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("channel_not_found");
  });

  it("on 429 returns ratelimited with retryAfter from header", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", {
        status: 429,
        headers: { "Retry-After": "30" },
      })
    );

    const result = await postMessage("xoxb-token", "C123", "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ratelimited");
    expect(result.retryAfter).toBe(30);
  });

  it("on 5xx returns a typed error rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Internal server error", { status: 503 })
    );

    const result = await postMessage("xoxb-token", "C123", "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("http_503");
  });

  it("on malformed 200 body returns a typed error rather than throwing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      })
    );

    const result = await postMessage("xoxb-token", "C123", "hi");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("invalid_response");
  });
});

describe("getChannelInfo", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches channel info via GET with bearer auth", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        channel: { id: "C123", name: "ops" },
      })
    );

    const result = await getChannelInfo("xoxb-token", "C123");

    expect(result.ok).toBe(true);
    expect(result.channel).toEqual({ id: "C123", name: "ops" });
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe("https://slack.com/api/conversations.info?channel=C123");
    expect(init?.method ?? "GET").toBe("GET");
    const headers = init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer xoxb-token");
  });

  it("returns Slack's error envelope on lookup failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      jsonResponse({ ok: false, error: "channel_not_found" })
    );

    const result = await getChannelInfo("xoxb-token", "C404");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("channel_not_found");
  });

  it("on 429 returns ratelimited with retryAfter", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", {
        status: 429,
        headers: { "Retry-After": "5" },
      })
    );

    const result = await getChannelInfo("xoxb-token", "C123");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("ratelimited");
    expect(result.retryAfter).toBe(5);
  });

  it("on 5xx returns a typed error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("oops", { status: 500 }));

    const result = await getChannelInfo("xoxb-token", "C123");
    expect(result.ok).toBe(false);
    expect(result.error).toBe("http_500");
  });
});
