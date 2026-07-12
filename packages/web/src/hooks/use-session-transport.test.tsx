// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ServerMessage } from "@open-inspect/shared";
import { useSessionTransport } from "./use-session-transport";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readyState = FakeWebSocket.CONNECTING;
  sentMessages: Array<Record<string, unknown>> = [];

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sentMessages.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code = 1000, reason = "") {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason, wasClean: true } as CloseEvent);
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  serverClose(code: number, wasClean = false) {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason: "", wasClean } as CloseEvent);
  }

  receiveRaw(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }

  receive(message: ServerMessage) {
    this.receiveRaw(JSON.stringify(message));
  }
}

describe("useSessionTransport", () => {
  let onMessage: ReturnType<typeof vi.fn<(message: ServerMessage) => void>>;
  let onClose: ReturnType<typeof vi.fn<() => void>>;
  let fetchMock: ReturnType<typeof vi.fn>;

  function renderTransport() {
    return renderHook(() => useSessionTransport("session-1", { onMessage, onClose }));
  }

  async function openSocket() {
    const rendered = renderTransport();
    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });
    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });
    return { ...rendered, socket };
  }

  beforeEach(() => {
    FakeWebSocket.instances = [];
    onMessage = vi.fn<(message: ServerMessage) => void>();
    onClose = vi.fn<() => void>();
    fetchMock = vi.fn(async () => Response.json({ token: "ws-token" }));
    vi.stubGlobal("WebSocket", FakeWebSocket as unknown as typeof WebSocket);
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValue(
      "00000000-0000-0000-0000-000000000000"
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fetches a token and sends the subscribe handshake on open", async () => {
    const { result, socket } = await openSocket();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/sessions/session-1/ws-token",
      expect.objectContaining({ method: "POST" })
    );
    expect(socket.sentMessages).toEqual([
      {
        type: "subscribe",
        token: "ws-token",
        clientId: "00000000-0000-0000-0000-000000000000",
      },
    ]);
    await waitFor(() => {
      expect(result.current.connected).toBe(true);
      expect(result.current.connecting).toBe(false);
    });
    expect(result.current.isOpen()).toBe(true);
  });

  it("forwards schema-valid messages to onMessage and drops the rest", async () => {
    const { socket } = await openSocket();

    act(() => {
      socket.receive({ type: "pong", timestamp: 5 });
      socket.receiveRaw(JSON.stringify({ type: "not_a_message" }));
      socket.receiveRaw("not json");
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: "pong", timestamp: 5 });
  });

  it("surfaces an auth error when the token endpoint returns 401 and opens no socket", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const { result } = renderTransport();

    await waitFor(() => {
      expect(result.current.authError).toBe("Please sign in to connect");
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(result.current.connecting).toBe(false);
  });

  it("sets an auth error on close code 4001 and fetches a fresh token on reconnect", async () => {
    const { result, socket } = await openSocket();

    act(() => {
      socket.serverClose(4001);
    });

    await waitFor(() => {
      expect(result.current.authError).toBe("Authentication failed. Please sign in again.");
      expect(result.current.connected).toBe(false);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    // No automatic reconnect on auth failure.
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      result.current.reconnect();
    });

    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.authError).toBeNull();
  });

  it("reports session expiry on close code 4002 without reconnecting", async () => {
    const { result, socket } = await openSocket();

    act(() => {
      socket.serverClose(4002);
    });

    await waitFor(() => {
      expect(result.current.connectionError).toBe("Session expired. Please reconnect.");
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
  });

  it("reconnects with backoff after an unclean close and reuses the cached token", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(1006);
    });

    // First retry is scheduled at the base delay.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    // The token from the first connect is reused.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rendered.unmount();
  });

  it("gives up after exhausting reconnect attempts", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Never open the sockets: a successful open resets the attempt counter,
    // so exhaustion only happens on repeated failed connection attempts.
    for (let attempt = 0; attempt < 6; attempt++) {
      const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
      act(() => {
        socket.serverClose(1006);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000);
      });
    }

    expect(FakeWebSocket.instances).toHaveLength(6);
    expect(rendered.result.current.connectionError).toBe(
      "Connection lost. Please check your network and try reconnecting."
    );

    rendered.unmount();
  });

  it("sends keepalive pings while the socket is open", async () => {
    vi.useFakeTimers();
    renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const socket = FakeWebSocket.instances[0];
    act(() => {
      socket.open();
    });
    socket.sentMessages = [];

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(socket.sentMessages).toEqual([{ type: "ping" }]);
  });

  it("drops sends when the socket is not open", async () => {
    const { result, socket } = await openSocket();

    act(() => {
      socket.serverClose(1000, true);
    });

    await waitFor(() => {
      expect(result.current.connected).toBe(false);
    });
    expect(result.current.isOpen()).toBe(false);
    result.current.send({ type: "typing" });
    expect(socket.sentMessages).toHaveLength(1); // only the subscribe handshake
  });
});
