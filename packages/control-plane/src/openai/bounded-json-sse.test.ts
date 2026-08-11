import { describe, expect, it, vi } from "vitest";
import {
  BoundedJsonSseAbortError,
  decodeBoundedJsonSse,
  InvalidBoundedJsonSseError,
  waitForAbort,
} from "./bounded-json-sse";

const DEFAULT_LIMITS = {
  maxTotalBytes: 1_024,
  maxEventBytes: 512,
  maxEvents: 10,
};

function responseFromBytes(
  chunks: readonly Uint8Array[],
  options: {
    close?: boolean;
    cancel?: () => void | Promise<void>;
  } = {}
): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        if (options.close !== false) controller.close();
      },
      cancel: options.cancel,
    })
  );
}

function responseFromText(
  body: string,
  options?: Parameters<typeof responseFromBytes>[1]
): Response {
  return responseFromBytes([new TextEncoder().encode(body)], options);
}

async function collectEvents(
  response: Response,
  limits: Partial<typeof DEFAULT_LIMITS> = {},
  signal = new AbortController().signal
): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of decodeBoundedJsonSse(response, signal, {
    ...DEFAULT_LIMITS,
    ...limits,
  })) {
    events.push(event);
  }
  return events;
}

describe("bounded JSON SSE decoder", () => {
  it("decodes fragmented UTF-8, CRLF, and multiline data while ignoring SSE metadata", async () => {
    const body =
      ': heartbeat\r\nevent: response.created\r\nid: 1\r\ndata: {"type":\r\ndata: "response.created","label":"luna 🌙"}\r\n\r\n';
    const bytes = new TextEncoder().encode(body);
    const moonOffset = bytes.indexOf(0xf0);
    const response = responseFromBytes([
      bytes.slice(0, moonOffset + 1),
      bytes.slice(moonOffset + 1, moonOffset + 3),
      bytes.slice(moonOffset + 3),
    ]);

    await expect(collectEvents(response)).resolves.toEqual([
      { type: "response.created", label: "luna 🌙" },
    ]);
  });

  it("accepts exact byte and event limits", async () => {
    const body = 'data: {"value":1}\n\ndata: {"value":2}\n\n';
    const bodyBytes = new TextEncoder().encode(body).byteLength;

    await expect(
      collectEvents(responseFromText(body), {
        maxTotalBytes: bodyBytes,
        maxEventBytes: new TextEncoder().encode('{"value":1}').byteLength,
        maxEvents: 2,
      })
    ).resolves.toEqual([{ value: 1 }, { value: 2 }]);
  });

  it("ignores an SSE event without data", async () => {
    await expect(collectEvents(responseFromText("event: ping\n\n"))).resolves.toEqual([]);
  });

  it("rejects an event after the event-count limit", async () => {
    const response = responseFromText('data: {"value":1}\n\ndata: {"value":2}\n\n');

    await expect(collectEvents(response, { maxEvents: 1 })).rejects.toBeInstanceOf(
      InvalidBoundedJsonSseError
    );
  });

  it("rejects malformed JSON", async () => {
    await expect(collectEvents(responseFromText("data: not-json\n\n"))).rejects.toBeInstanceOf(
      InvalidBoundedJsonSseError
    );
  });

  it("rejects a response over the total byte limit", async () => {
    await expect(
      collectEvents(responseFromText('data: {"value":1}\n\n'), { maxTotalBytes: 4 })
    ).rejects.toBeInstanceOf(InvalidBoundedJsonSseError);
  });

  it("rejects event data over the per-event byte limit", async () => {
    await expect(
      collectEvents(responseFromText('data: {"value":"too large"}\n\n'), {
        maxEventBytes: 8,
      })
    ).rejects.toBeInstanceOf(InvalidBoundedJsonSseError);
  });

  it("rejects an unterminated line over the per-event byte limit", async () => {
    await expect(
      collectEvents(responseFromText("data: an-unterminated-line"), {
        maxEventBytes: 8,
      })
    ).rejects.toBeInstanceOf(InvalidBoundedJsonSseError);
  });

  it("rejects a response without a body", async () => {
    await expect(collectEvents(new Response(null))).rejects.toBeInstanceOf(
      InvalidBoundedJsonSseError
    );
  });

  it("rejects immediately when an operation starts with an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(waitForAbort(Promise.resolve("unused"), controller.signal)).rejects.toBeInstanceOf(
      BoundedJsonSseAbortError
    );
  });

  it("aborts a pending read and cancels the response body", async () => {
    const cancel = vi.fn();
    const response = responseFromBytes([], { close: false, cancel });
    const controller = new AbortController();
    const result = collectEvents(response, {}, controller.signal);

    controller.abort();

    await expect(result).rejects.toBeInstanceOf(BoundedJsonSseAbortError);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("normalizes stream read failures without exposing their cause", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.error(new Error("sensitive upstream failure"));
        },
      })
    );

    await expect(collectEvents(response)).rejects.toEqual(new InvalidBoundedJsonSseError());
  });

  it("cancels an open response when its consumer stops after one event", async () => {
    const cancel = vi.fn();
    const response = responseFromText('data: {"value":1}\n\n', { close: false, cancel });
    const iterator = decodeBoundedJsonSse(response, new AbortController().signal, DEFAULT_LIMITS);

    await expect(iterator.next()).resolves.toEqual({ value: { value: 1 }, done: false });
    await iterator.return(undefined);

    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
  });

  it("still releases the body lock when cancellation fails", async () => {
    const response = responseFromText('data: {"value":1}\n\n', {
      close: false,
      cancel: () => Promise.reject(new Error("cancel failed")),
    });
    const iterator = decodeBoundedJsonSse(response, new AbortController().signal, DEFAULT_LIMITS);

    await iterator.next();
    await expect(iterator.return(undefined)).resolves.toEqual({ value: undefined, done: true });
    expect(response.body?.locked).toBe(false);
  });
});
