import { describe, it, expect, vi } from "vitest";
import {
  relayMcpRequest,
  readMcpBody,
  MCP_MAX_BODY_BYTES,
  MCP_STREAM_REVALIDATE_INTERVAL_MS,
  MCP_STREAM_TIMEOUT_MS,
} from "./relay";
import { McpError } from "./errors";
const target = "https://mcp.fixture.test/mcp";
const req = (body = "{}", headers = {}) =>
  new Request("https://proxy.fixture.test/mcp", { method: "POST", body, headers });
const options = () => ({
  target,
  upstreamHeaders: { Authorization: "Bearer upstream" },
  personal: true,
  revalidate: vi.fn(async () => {}),
});
describe("managed MCP transparent, single-attempt relay", () => {
  it("forwards bytes and only protocol headers, stripping both credential boundaries", async () => {
    const fetcher = vi.fn(async (r: Request) => {
      expect(await r.text()).toBe('{"jsonrpc":"2.0","id":2}');
      expect(Object.fromEntries(r.headers)).toEqual({
        authorization: "Bearer upstream",
        "content-type": "application/json",
        "mcp-session-id": "remote-session",
      });
      expect(r.redirect).toBe("manual");
      return new Response('{"result":{}}', {
        headers: {
          "content-type": "application/json",
          "set-cookie": "secret",
          "www-authenticate": "secret",
          location: "https://secret",
          "mcp-session-id": "remote-session",
          "cache-control": "public",
        },
      });
    });
    const response = await relayMcpRequest(
      req('{"jsonrpc":"2.0","id":2}', {
        authorization: "Bearer sandbox",
        cookie: "private",
        origin: "https://untrusted",
        "content-type": "application/json",
        "mcp-session-id": "remote-session",
      }),
      { ...options(), fetcher }
    );
    expect(await response.text()).toBe('{"result":{}}');
    expect(Object.fromEntries(response.headers)).toEqual({
      "content-type": "application/json",
      "mcp-session-id": "remote-session",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("preserves empty 202 acknowledgements across real HTTP adapter body shapes", async () => {
    const response = await relayMcpRequest(req(), {
      ...options(),
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          { status: 202 }
        ),
    });
    expect(response.status).toBe(202);
    expect(response.body).toBeNull();
  });
  it("preserves empty untyped 200 responses such as DELETE acknowledgements", async () => {
    const complete = vi.fn();
    const response = await relayMcpRequest(req(), {
      ...options(),
      onComplete: complete,
      fetcher: async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          { status: 200 }
        ),
    });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(complete).toHaveBeenCalledOnce();
  });
  it("rejects untyped success responses that carry content", async () => {
    await expect(
      relayMcpRequest(req(), {
        ...options(),
        fetcher: async () =>
          new Response(
            new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode("opaque"));
                c.close();
              },
            }),
            { status: 200 }
          ),
      })
    ).rejects.toMatchObject({ code: "mcp_unsupported" });
  });
  it.each([301, 307, 401])("does not follow or replay an upstream %s", async (status) => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status,
          headers: { location: target, "www-authenticate": "Bearer secret" },
        })
    );
    await expect(relayMcpRequest(req(), { ...options(), fetcher })).rejects.toBeInstanceOf(
      McpError
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([400, 404, 405, 500])(
    "preserves empty HTTP %s recovery semantics without replay",
    async (status) => {
      const complete = vi.fn();
      const fetcher = vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.close();
              },
            }),
            { status }
          )
      );
      const response = await relayMcpRequest(req(), {
        ...options(),
        fetcher,
        onComplete: complete,
      });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("");
      expect(fetcher).toHaveBeenCalledOnce();
      expect(complete).toHaveBeenCalledOnce();
    }
  );
  it("discards unsupported upstream error bodies but preserves protocol status", async () => {
    const response = await relayMcpRequest(req(), {
      ...options(),
      fetcher: async () =>
        new Response("<html>gateway diagnostics</html>", {
          status: 502,
          headers: { "Content-Type": "text/html", "Set-Cookie": "private" },
        }),
    });
    expect(response.status).toBe(502);
    expect(await response.text()).toBe("");
    expect(response.headers.get("Set-Cookie")).toBeNull();
  });
  it("does not replay a mutation after its response is lost", async () => {
    let mutations = 0;
    await expect(
      relayMcpRequest(req(), {
        ...options(),
        fetcher: async () => {
          mutations++;
          throw new Error("lost response");
        },
      })
    ).rejects.toMatchObject({ code: "mcp_unavailable" });
    expect(mutations).toBe(1);
  });
  it("rechecks the captured authority before forwarding and releases failed requests", async () => {
    const fetcher = vi.fn();
    const onComplete = vi.fn();
    await expect(
      relayMcpRequest(req(), {
        ...options(),
        fetcher,
        onComplete,
        revalidate: async () => {
          throw new McpError("mcp_context_changed");
        },
      })
    ).rejects.toMatchObject({ code: "mcp_context_changed" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledOnce();
  });
  it("delivers the first SSE chunk without EOF, retains the lease, and cancels upstream", async () => {
    const cancel = vi.fn();
    const complete = vi.fn();
    let signal: AbortSignal;
    const response = await relayMcpRequest(new Request(target), {
      ...options(),
      onComplete: complete,
      fetcher: async (r) => {
        signal = r.signal;
        return new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode("data: first\n\n"));
            },
            cancel,
          }),
          { headers: { "content-type": "text/event-stream" } }
        );
      },
    });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("data: first\n\n");
    expect(complete).not.toHaveBeenCalled();
    await reader.cancel();
    expect(cancel).toHaveBeenCalledOnce();
    expect(signal!.aborted).toBe(true);
    expect(complete).toHaveBeenCalledOnce();
  });
  it("limits chunked bodies and closes slow uploads without forwarding", async () => {
    await expect(readMcpBody(req("x".repeat(MCP_MAX_BODY_BYTES + 1)))).rejects.toMatchObject({
      code: "mcp_request_too_large",
    });
    vi.useFakeTimers();
    try {
      const request = new Request(target, {
        method: "POST",
        body: new ReadableStream(),
        duplex: "half",
      } as RequestInit);
      const pending = expect(readMcpBody(request)).rejects.toMatchObject({ status: 408 });
      await vi.advanceTimersByTimeAsync(15_001);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
  it("stops an open stream once its authority ends, without rechecking every chunk", async () => {
    vi.useFakeTimers();
    const complete = vi.fn();
    let upstreamSignal: AbortSignal | undefined;
    let push: ((chunk: string) => void) | undefined;
    const revalidate = vi.fn(async () => {});
    try {
      const response = await relayMcpRequest(req(), {
        ...options(),
        revalidate,
        onComplete: complete,
        fetcher: async (request) => {
          upstreamSignal = request.signal;
          return new Response(
            new ReadableStream({
              start(controller) {
                push = (chunk) => controller.enqueue(new TextEncoder().encode(chunk));
              },
            }),
            { headers: { "Content-Type": "text/event-stream" } }
          );
        },
      });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      expect(revalidate).toHaveBeenCalledOnce(); // Before the upstream request.

      push!("data: first\n\n");
      expect(decoder.decode((await reader.read()).value)).toBe("data: first\n\n");
      push!("data: second\n\n");
      expect(decoder.decode((await reader.read()).value)).toBe("data: second\n\n");
      expect(revalidate).toHaveBeenCalledOnce();

      // The turn closes; the next chunk arrives after the interval.
      revalidate.mockRejectedValue(new McpError("mcp_execution_inactive"));
      await vi.advanceTimersByTimeAsync(MCP_STREAM_REVALIDATE_INTERVAL_MS);
      push!("data: after close\n\n");
      await expect(reader.read()).rejects.toThrow("MCP stream authority ended");
      expect(revalidate).toHaveBeenCalledTimes(2);
      expect(upstreamSignal?.aborted).toBe(true);
      expect(complete).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("rejects a body its deadline cut off even while the clock lags the timer", async () => {
    // Only the timer is fake, so the wall clock has not reached the deadline when
    // cancellation resolves the pending read as done.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const request = new Request(target, {
        method: "POST",
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'));
          },
        }),
        duplex: "half",
      } as RequestInit);
      const pending = expect(readMcpBody(request)).rejects.toMatchObject({ status: 408 });
      await vi.advanceTimersByTimeAsync(15_001);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });
  it.each(["client abort", "stream deadline"])(
    "releases a backpressured lease on %s without another read",
    async (cause) => {
      vi.useFakeTimers();
      const complete = vi.fn();
      const cancellation = new AbortController();
      let upstreamSignal: AbortSignal | undefined;
      let response: Response | undefined;
      try {
        response = await relayMcpRequest(new Request(target, { signal: cancellation.signal }), {
          ...options(),
          onComplete: complete,
          fetcher: async (request) => {
            upstreamSignal = request.signal;
            return new Response(
              new ReadableStream({
                pull(controller) {
                  controller.enqueue(new TextEncoder().encode("data: event\n\n"));
                },
              }),
              { headers: { "Content-Type": "text/event-stream" } }
            );
          },
        });
        // Let the relay fill its queue, then stop consuming it entirely.
        await vi.advanceTimersByTimeAsync(0);
        expect(complete).not.toHaveBeenCalled();
        if (cause === "client abort") cancellation.abort();
        else await vi.advanceTimersByTimeAsync(MCP_STREAM_TIMEOUT_MS);
        expect(upstreamSignal?.aborted).toBe(true);
        expect(complete).toHaveBeenCalledOnce();
        await response.body!.cancel();
        expect(complete).toHaveBeenCalledOnce();
      } finally {
        await response?.body?.cancel();
        vi.useRealTimers();
      }
    }
  );
});
