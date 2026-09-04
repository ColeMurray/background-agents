import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket as NodeWebSocket, WebSocketServer } from "ws";
import type { Logger } from "../logger";
import { isSocketOpen, type SessionWebSocket } from "../platform-ports";
import {
  BACKLOG_EXCEEDED_CLOSE_CODE,
  NodeWebSocketHost,
  type NodeSocketHostOptions,
  type SessionWebSocketEventSink,
} from "./socket-host";

function createLogger(): Logger {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => log),
  };
  return log as unknown as Logger;
}

function createEvents() {
  return {
    onMessage: vi.fn(async (_ws: SessionWebSocket, _message: string | ArrayBuffer) => {}),
    onClose: vi.fn(
      async (_ws: SessionWebSocket, _code: number, _reason: string, _wasClean: boolean) => {}
    ),
    onError: vi.fn((_ws: SessionWebSocket, _error: Error) => {}),
  } satisfies SessionWebSocketEventSink;
}

/** A real `ws` server on an ephemeral port whose connections the test accepts into `host`. */
async function createHarness(options: NodeSocketHostOptions = {}) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  const log = createLogger();
  const events = createEvents();
  const host = new NodeWebSocketHost(log, options);
  host.bindEventSink(events);
  const clients: NodeWebSocket[] = [];

  /** Open one connection; resolves once the server side is accepted under `tags`. */
  async function connect(
    tags: string[]
  ): Promise<{ client: NodeWebSocket; socket: NodeWebSocket }> {
    const accepted = new Promise<NodeWebSocket>((resolve) => {
      server.once("connection", (socket) => {
        host.adopt(socket, tags);
        resolve(socket);
      });
    });
    const client = new NodeWebSocket(`ws://127.0.0.1:${port}`);
    clients.push(client);
    await once(client, "open");
    return { client, socket: await accepted };
  }

  return {
    host,
    events,
    log,
    server,
    connect,
    /** A server-side socket the host never upgraded, for wiring-error tests. */
    port,
    async close() {
      for (const client of clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

type Harness = Awaited<ReturnType<typeof createHarness>>;

describe("NodeWebSocketHost", () => {
  let harness: Harness | null = null;
  afterEach(async () => {
    await harness?.close();
    harness = null;
  });

  it("adopts sockets under their tags and enumerates them by tag", async () => {
    harness = await createHarness();
    const client1 = await harness.connect(["wsid:ws-1"]);
    const sandbox = await harness.connect(["sandbox", "sid:sb-1", "socket:sbws-1"]);

    expect(harness.host.tags(client1.socket)).toEqual(["wsid:ws-1"]);
    expect(harness.host.tags(sandbox.socket)).toEqual(["sandbox", "sid:sb-1", "socket:sbws-1"]);
    expect(harness.host.sockets()).toEqual([client1.socket, sandbox.socket]);
    expect(harness.host.sockets("sandbox")).toEqual([sandbox.socket]);
    expect(harness.host.sockets("wsid:ws-1")).toEqual([client1.socket]);
    expect(harness.host.sockets("missing")).toEqual([]);
  });

  it("returns no tags for a socket it never accepted", async () => {
    harness = await createHarness();
    expect(harness.host.tags({ readyState: 1, send() {}, close() {} })).toEqual([]);
  });

  it("refuses sockets it did not upgrade, double adoptions, and adoptions before bindEventSink", async () => {
    harness = await createHarness();
    const { socket } = await harness.connect(["wsid:ws-1"]);

    expect(() => harness!.host.adopt({ readyState: 1, send() {}, close() {} }, [])).toThrow(
      TypeError
    );
    expect(() => harness!.host.adopt(socket, ["wsid:again"])).toThrow(/already adopted/);
    expect(() => new NodeWebSocketHost(createLogger()).adopt(socket, [])).toThrow(
      /before bindEventSink/
    );
    expect(() => harness!.host.bindEventSink(harness!.events)).toThrow(/already bound/);
  });

  it("forwards text frames as strings and binary frames as ArrayBuffers", async () => {
    harness = await createHarness();
    const { client, socket } = await harness.connect(["wsid:ws-1"]);

    client.send('{"type":"typing"}');
    client.send(new Uint8Array([1, 2, 3]));
    await vi.waitFor(() => expect(harness!.events.onMessage).toHaveBeenCalledTimes(2));

    const [first, second] = harness.events.onMessage.mock.calls;
    expect(first).toEqual([socket, '{"type":"typing"}']);
    expect(second[0]).toBe(socket);
    expect(second[1]).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(second[1] as ArrayBuffer)]).toEqual([1, 2, 3]);
  });

  it("answers the exact keepalive request without delivering it", async () => {
    harness = await createHarness();
    harness.host.setAutoResponse('{"type":"ping"}', '{"type":"pong","timestamp":1}');
    const { client } = await harness.connect(["wsid:ws-1"]);

    client.send('{"type":"ping"}');
    const [reply] = await once(client, "message");
    expect(String(reply)).toBe('{"type":"pong","timestamp":1}');
    expect(harness.events.onMessage).not.toHaveBeenCalled();

    // Only the exact payload is platform-level; anything else reaches the runtime.
    client.send('{"type":"ping","extra":true}');
    await vi.waitFor(() => expect(harness!.events.onMessage).toHaveBeenCalledOnce());
  });

  it("delivers a runtime-initiated close to the peer and to the runtime, then drops the socket", async () => {
    harness = await createHarness();
    const { client, socket } = await harness.connect(["wsid:ws-1"]);

    socket.close(4008, "Authentication timeout");
    const [code, reason] = await once(client, "close");
    expect(code).toBe(4008);
    expect(String(reason)).toBe("Authentication timeout");

    await vi.waitFor(() =>
      expect(harness!.events.onClose).toHaveBeenCalledWith(
        socket,
        4008,
        "Authentication timeout",
        true
      )
    );
    expect(harness.host.sockets()).toEqual([]);
    // Classification survives the close: the disconnect handler still needs the tags.
    expect(harness.host.tags(socket)).toEqual(["wsid:ws-1"]);
  });

  it("reports a lost connection as an unclean 1006 close", async () => {
    harness = await createHarness();
    const { client, socket } = await harness.connect(["sandbox", "sid:sb-1"]);

    client.terminate();

    await vi.waitFor(() =>
      expect(harness!.events.onClose).toHaveBeenCalledWith(socket, 1006, "", false)
    );
    expect(harness.host.sockets("sandbox")).toEqual([]);
  });

  it("delivers one socket's events in order, one at a time, close last", async () => {
    harness = await createHarness();
    const { client, socket } = await harness.connect(["wsid:ws-1"]);
    let releaseFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      harness!.events.onMessage.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((release) => {
          releaseFirst = release;
        });
      });
    });
    const order: string[] = [];
    harness.events.onMessage.mockImplementation(async (_ws, message) => {
      order.push(`message:${String(message)}`);
    });
    harness.events.onClose.mockImplementation(async () => {
      order.push("close");
    });

    client.send("one");
    await firstStarted;
    client.send("two");
    client.close(1000, "done");
    // Nothing behind the blocked handler is delivered until it settles.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(order).toEqual([]);

    releaseFirst();
    await vi.waitFor(() => expect(order).toEqual(["message:two", "close"]));
    expect(harness.events.onClose).toHaveBeenCalledWith(socket, 1000, "done", true);
  });

  it("logs a failed delivery and keeps delivering", async () => {
    harness = await createHarness();
    const { client, socket } = await harness.connect(["wsid:ws-1"]);
    harness.events.onMessage.mockRejectedValueOnce(new Error("handler exploded"));

    client.send("first");
    client.send("second");

    await vi.waitFor(() => expect(harness!.events.onMessage).toHaveBeenCalledTimes(2));
    expect(harness.events.onMessage).toHaveBeenLastCalledWith(socket, "second");
    expect(harness.log.error).toHaveBeenCalledWith(
      "socket.delivery_failed",
      expect.objectContaining({ tags: ["wsid:ws-1"], error: expect.any(Error) })
    );
  });

  it("forwards socket errors to the runtime", async () => {
    harness = await createHarness();
    const { socket } = await harness.connect(["wsid:ws-1"]);
    const failure = new Error("boom");

    socket.emit("error", failure);

    await vi.waitFor(() => expect(harness!.events.onError).toHaveBeenCalledWith(socket, failure));
  });

  it("reports an incomplete closing handshake as unclean even with a normal code", async () => {
    harness = await createHarness();
    const { socket } = await harness.connect(["wsid:ws-1"]);

    // `ws` derives wasClean from both close-frame flags; the peer's frame
    // arrived but ours never went out. Emitting the close with those flags
    // set is how that state is observable without racing a real handshake.
    const internals = socket as unknown as {
      _closeFrameReceived: boolean;
      _closeFrameSent: boolean;
    };
    internals._closeFrameReceived = true;
    internals._closeFrameSent = false;
    socket.emit("close", 1000, Buffer.from("half"));

    await vi.waitFor(() =>
      expect(harness!.events.onClose).toHaveBeenCalledWith(socket, 1000, "half", false)
    );
  });

  it("pauses a flooding peer while a delivery is in flight and loses nothing", async () => {
    harness = await createHarness();
    const { client, socket } = await harness.connect(["sandbox", "sid:sb-1"]);
    let release!: () => void;
    const firstStarted = new Promise<void>((resolve) => {
      harness!.events.onMessage.mockImplementationOnce(async () => {
        resolve();
        await new Promise<void>((done) => {
          release = done;
        });
      });
    });
    const delivered: string[] = [];
    harness.events.onMessage.mockImplementation(async (_ws, message) => {
      delivered.push(String(message));
    });

    client.send("0");
    await firstStarted;
    // Paused before the first delivery starts, not once a second frame shows
    // up: otherwise the next message is assembled on the heap meanwhile.
    expect(socket.isPaused).toBe(true);
    // Frames large enough that the flood spans several socket reads, so
    // pausing has reads left to hold back.
    const flood = Array.from({ length: 1_000 }, (_, i) => `frame-${i + 1}`.padEnd(256, "."));
    for (const frame of flood) client.send(frame);

    // Backpressure, not heap growth: the socket stops reading while the
    // runtime is busy, so the flood waits in the kernel.
    await vi.waitFor(() => expect(socket.isPaused).toBe(true));
    expect(delivered).toEqual([]);

    release();
    await vi.waitFor(() => expect(delivered).toHaveLength(flood.length), { timeout: 5_000 });
    expect(delivered).toEqual(flood);
    expect(socket.isPaused).toBe(false);
    expect(harness.log.warn).not.toHaveBeenCalled();
  }, 15_000);

  it("closes a peer whose parsed backlog exceeds the bound instead of retaining it", async () => {
    harness = await createHarness({ maxPendingDeliveries: 3 });
    const { client, socket } = await harness.connect(["wsid:ws-1"]);
    harness.events.onMessage.mockImplementationOnce(
      () => new Promise<void>(() => {}) // never settles
    );

    // Frames `ws` already decoded reach the host regardless of pause; emit
    // them directly to model that burst deterministically.
    socket.emit("message", Buffer.from("blocking"), false);
    for (let i = 0; i < 4; i += 1) socket.emit("message", Buffer.from(`queued-${i}`), false);

    const [code, reason] = await once(client, "close");
    expect(code).toBe(BACKLOG_EXCEEDED_CLOSE_CODE);
    expect(String(reason)).toBe("Message backlog exceeded");
    expect(harness.log.warn).toHaveBeenCalledWith(
      "socket.backlog_exceeded",
      expect.objectContaining({ tags: ["wsid:ws-1"], pending: 3 })
    );
    // The peer observing the close does not order the server-side listener.
    await vi.waitFor(() => expect(harness!.host.sockets()).toEqual([]));
    // The blocked handler still holds this socket's queue, close included:
    // bounding handler time is the executor's job, not the host's.
    expect(harness.events.onMessage).toHaveBeenCalledOnce();
    expect(harness.events.onClose).not.toHaveBeenCalled();
  });

  it("satisfies the core's open check without the ambient WebSocket global", async () => {
    harness = await createHarness();
    const { socket } = await harness.connect(["wsid:ws-1"]);

    expect(isSocketOpen(socket)).toBe(true);
    socket.close();
    expect(isSocketOpen(socket)).toBe(false);
  });
});
