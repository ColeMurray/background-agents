// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import {
  WS_CLOSE_GOING_AWAY,
  WS_CLOSE_SERVICE_RESTART,
  WS_CLOSE_TRY_AGAIN_LATER,
} from "@open-inspect/shared/types/websocket";
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

  function setVisibility(value: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", { configurable: true, value });
  }

  function setOnline(value: boolean) {
    Object.defineProperty(navigator, "onLine", { configurable: true, value });
  }

  beforeEach(() => {
    setVisibility("visible");
    setOnline(true);
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

  it("reports a synchronous send refusal after the socket starts closing", async () => {
    const { result, socket } = await openSocket();
    socket.readyState = FakeWebSocket.CLOSING;

    expect(result.current.send({ type: "recover_preservation" })).toBe(false);
    expect(socket.sentMessages).toHaveLength(1);
  });

  it("reports a synchronous socket send exception", async () => {
    const { result, socket } = await openSocket();
    vi.spyOn(socket, "send").mockImplementation(() => {
      throw new Error("socket closed during send");
    });

    expect(result.current.send({ type: "recover_preservation" })).toBe(false);
  });

  it("does not fetch a token or open a socket when transport is disabled", async () => {
    const { result } = renderHook(() =>
      useSessionTransport("session-1", { onMessage, onClose }, false)
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(result.current.connected).toBe(false);
    expect(result.current.connecting).toBe(false);

    act(() => result.current.reconnect());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("resets transport state across enabled to disabled to enabled", async () => {
    const rendered = renderHook(
      ({ enabled }) => useSessionTransport("session-1", { onMessage, onClose }, enabled),
      { initialProps: { enabled: true } }
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    act(() => FakeWebSocket.instances[0].open());
    await waitFor(() => expect(rendered.result.current.connected).toBe(true));

    rendered.rerender({ enabled: false });

    await waitFor(() => {
      expect(rendered.result.current.connected).toBe(false);
      expect(rendered.result.current.connecting).toBe(false);
    });
    expect(rendered.result.current.isOpen()).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);

    rendered.rerender({ enabled: true });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    act(() => FakeWebSocket.instances[1].open());
    await waitFor(() => expect(rendered.result.current.connected).toBe(true));
  });

  it("forwards schema-valid messages to onMessage", async () => {
    const { socket } = await openSocket();

    act(() => {
      socket.receive({ type: "pong", timestamp: 5 });
    });

    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith({ type: "pong", timestamp: 5 });
  });

  it("strips a legacy output tail before forwarding a live boot phase", async () => {
    const { socket } = await openSocket();

    act(() => {
      socket.receiveRaw(
        JSON.stringify({
          type: "sandbox_event",
          event: {
            type: "boot_progress",
            bootSeq: 3,
            phase: "setup",
            status: "failed",
            detail: "setup hook failed",
            outputTail: ["legacy secret output"],
            sandboxId: "sandbox-1",
            timestamp: 123,
          },
        })
      );
    });

    expect(onMessage).toHaveBeenCalledWith({
      type: "sandbox_event",
      event: {
        type: "boot_progress",
        bootSeq: 3,
        phase: "setup",
        status: "failed",
        detail: "setup hook failed",
        sandboxId: "sandbox-1",
        timestamp: 123,
      },
    });
  });

  it.each([JSON.stringify({ type: "not_a_message" }), "not json"])(
    "reconnects after an invalid server message: %s",
    async (payload) => {
      vi.useFakeTimers();
      const rendered = renderTransport();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      const socket = FakeWebSocket.instances[0];
      act(() => {
        socket.open();
        socket.receiveRaw(payload);
      });

      expect(onMessage).not.toHaveBeenCalled();
      expect(onClose).toHaveBeenCalledTimes(1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      expect(FakeWebSocket.instances).toHaveLength(2);
      rendered.unmount();
    }
  );

  it("surfaces an auth error when the token endpoint returns 401 and opens no socket", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const { result } = renderTransport();

    await waitFor(() => {
      expect(result.current.authError).toBe("Please sign in to connect");
    });
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(result.current.connecting).toBe(false);
  });

  it.each(["initial", "authorization refresh"])(
    "treats a mint 404 during %s as terminal, including manual reconnect and re-enable",
    async (stage) => {
      vi.useFakeTimers();
      fetchMock.mockResolvedValue(Response.json({ error: "Not found" }, { status: 404 }));
      if (stage === "authorization refresh") {
        fetchMock.mockResolvedValueOnce(Response.json({ token: "original-token" }));
      }
      const rendered = renderHook(
        ({ enabled }) => useSessionTransport("session-1", { onMessage, onClose }, enabled),
        { initialProps: { enabled: true } }
      );
      await act(async () => vi.advanceTimersByTimeAsync(0));
      if (stage === "authorization refresh") {
        act(() => {
          FakeWebSocket.instances[0].open();
          FakeWebSocket.instances[0].serverClose(4010, true);
        });
        await act(async () => vi.advanceTimersByTimeAsync(0));
      }

      expect(rendered.result.current).toMatchObject({
        sessionGone: true,
        connected: false,
        connecting: false,
        reconnecting: false,
        authError: null,
        connectionError: null,
      });
      act(() => rendered.result.current.reconnect());
      rendered.rerender({ enabled: false });
      rendered.rerender({ enabled: true });
      await act(async () => vi.advanceTimersByTimeAsync(300_000));
      expect(fetchMock).toHaveBeenCalledTimes(stage === "initial" ? 1 : 2);
      expect(FakeWebSocket.instances).toHaveLength(stage === "initial" ? 0 : 1);
      expect(rendered.result.current.sessionGone).toBe(true);
      rendered.unmount();
    }
  );

  it("ignores a previous session's late mint 404 and clears gone for a different session", async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveOld = resolve))
    );
    const rendered = renderHook(
      ({ sessionId }) => useSessionTransport(sessionId, { onMessage, onClose }),
      { initialProps: { sessionId: "old-session" } }
    );
    rendered.rerender({ sessionId: "new-session" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await act(async () => resolveOld(Response.json({ error: "Not found" }, { status: 404 })));
    expect(rendered.result.current.sessionGone).toBe(false);
    expect(rendered.result.current.authError).toBeNull();
    act(() => FakeWebSocket.instances[0].open());
    expect(rendered.result.current.connected).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    act(() => rendered.result.current.reconnect());
    await waitFor(() => expect(rendered.result.current.sessionGone).toBe(true));
    rendered.rerender({ sessionId: "third-session" });
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(rendered.result.current.sessionGone).toBe(false);
    expect(FakeWebSocket.instances[1].url).toContain("/sessions/third-session/ws");
  });

  it("ignores a superseded same-session mint 404 after manual reconnect", async () => {
    let resolveOld!: (response: Response) => void;
    fetchMock.mockImplementationOnce(
      () => new Promise<Response>((resolve) => (resolveOld = resolve))
    );
    const { result } = renderTransport();
    act(() => result.current.reconnect());
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    await act(async () => resolveOld(new Response(null, { status: 404 })));
    expect(result.current.sessionGone).toBe(false);
    act(() => FakeWebSocket.instances[0].open());
    expect(result.current.connected).toBe(true);
  });

  it("refreshes a rejected credential once, then reports an auth error", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // One automatic refresh: the credential may simply be stale.
    act(() => FakeWebSocket.instances[0].serverClose(4001, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rendered.result.current.authError).toBeNull();

    // A freshly issued credential rejected too is a real auth failure.
    act(() => FakeWebSocket.instances[1].serverClose(4001, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(rendered.result.current.authError).toBe("Authentication failed. Please sign in again.");
    expect(rendered.result.current.connected).toBe(false);

    act(() => rendered.result.current.reconnect());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(rendered.result.current.authError).toBeNull();
    rendered.unmount();
  });

  it("refreshes a credential another tab invalidated while the host was restarting", async () => {
    // Only one WebSocket credential is stored per participant, so a second tab
    // opening the session invalidates this tab's cached token. The restart is
    // when that is discovered: the retry presents the stale token and is closed
    // 4001, which has to recover on its own rather than sit behind a banner.
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    fetchMock
      .mockResolvedValueOnce(Response.json({ token: "stale-token" }))
      .mockResolvedValueOnce(Response.json({ token: "reissued-token" }));
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(WS_CLOSE_SERVICE_RESTART, true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].sentMessages).toEqual([]);

    act(() => FakeWebSocket.instances[1].serverClose(4001, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(FakeWebSocket.instances).toHaveLength(3);
    act(() => FakeWebSocket.instances[2].open());
    expect(FakeWebSocket.instances[2].sentMessages).toEqual([
      expect.objectContaining({ token: "reissued-token" }),
    ]);
    expect(rendered.result.current.connected).toBe(true);
    expect(rendered.result.current.authError).toBeNull();
    rendered.unmount();
  });

  it("restores the credential-refresh budget once a connection synchronizes", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => FakeWebSocket.instances[0].serverClose(4001, true));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    act(() => {
      FakeWebSocket.instances[1].open();
      rendered.result.current.markHealthy();
      FakeWebSocket.instances[1].serverClose(4001, true);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // The budget is spent per healthy connection, not once per page load.
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(rendered.result.current.authError).toBeNull();
    rendered.unmount();
  });

  it("reconnects with a fresh credential after session expiry (4002)", async () => {
    // The host closes 4002 when hibernation lost the socket's lease and asks
    // the client to reconnect; a banner would only make the user do it.
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(Response.json({ token: "original-token" }))
      .mockResolvedValueOnce(Response.json({ token: "fresh-token" }));
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(4002, true);
    });
    expect(rendered.result.current.connectionError).toBeNull();
    expect(rendered.result.current.reconnecting).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    act(() => FakeWebSocket.instances[1].open());
    expect(FakeWebSocket.instances[1].sentMessages).toEqual([
      expect.objectContaining({ token: "fresh-token" }),
    ]);
    rendered.unmount();
  });

  it("fetches a fresh credential and reconnects after authorization revocation", async () => {
    vi.useFakeTimers();
    fetchMock
      .mockResolvedValueOnce(Response.json({ token: "original-token" }))
      .mockResolvedValueOnce(Response.json({ token: "refreshed-token" }));
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const original = FakeWebSocket.instances[0];
    act(() => {
      original.open();
      original.serverClose(4010, true);
    });
    // Every scheduled reconnect reports the wait, not just the backoff ones.
    expect(rendered.result.current.reconnecting).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const replacement = FakeWebSocket.instances[1];
    act(() => replacement.open());
    expect(replacement.sentMessages).toEqual([
      expect.objectContaining({ token: "refreshed-token" }),
    ]);
    rendered.unmount();
  });

  it("retries a clean transient server failure with the cached credential", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(1011, true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => FakeWebSocket.instances[1].open());
    expect(FakeWebSocket.instances[1].sentMessages).toEqual([
      expect.objectContaining({ token: "ws-token" }),
    ]);
    rendered.unmount();
  });

  it("reconnects after a service restart on a randomized RFC delay", async () => {
    // The host closes every adopted socket with WS_CLOSE_SERVICE_RESTART on
    // shutdown, and a proper close frame makes it a *clean* close in the
    // browser. RFC 6455 registers 1012 with a randomized 5-30s reconnect: the
    // restart hits every tab at once, and the host is not listening again a
    // second later anyway.
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(WS_CLOSE_SERVICE_RESTART, true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4_999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    // The credential outlives the host restart, so no second token fetch.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(rendered.result.current.connectionError).toBeNull();

    act(() => FakeWebSocket.instances[1].open());
    expect(rendered.result.current.connected).toBe(true);
    rendered.unmount();
  });

  it("spreads service-restart reconnects across the whole randomized window", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => FakeWebSocket.instances[0].serverClose(WS_CLOSE_SERVICE_RESTART, true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    rendered.unmount();
  });

  it("leaves an overloaded server alone and offers the user a reconnect", async () => {
    // 1013 is registered as overload, and this codebase's only sender closes a
    // peer for exhausting its own delivery backlog. Reconnecting on a timer
    // would repeat exactly what the host just refused, so the registry asks for
    // a reconnect on user action - which is what the banner's button is.
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(WS_CLOSE_TRY_AGAIN_LATER, true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rendered.result.current.reconnecting).toBe(false);
    expect(rendered.result.current.connectionError).toBe(
      "The server is too busy to accept the connection. Try reconnecting in a moment."
    );

    act(() => rendered.result.current.reconnect());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(rendered.result.current.connectionError).toBeNull();
    rendered.unmount();
  });

  it("reconnects on the transient backoff when the host goes away", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(WS_CLOSE_GOING_AWAY, true);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    rendered.unmount();
  });

  it("reports reconnecting while a scheduled retry is pending", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => FakeWebSocket.instances[0].open());
    expect(rendered.result.current.reconnecting).toBe(false);

    act(() => FakeWebSocket.instances[0].serverClose(WS_CLOSE_GOING_AWAY, true));
    expect(rendered.result.current.reconnecting).toBe(true);
    expect(rendered.result.current.connected).toBe(false);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(rendered.result.current.reconnecting).toBe(false);
    rendered.unmount();
  });

  it("keeps retrying a transient outage at the capped backoff without asking the user", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });

    // Past the ten attempts that used to end in a "Connection lost" banner.
    const expectedDelaysMs = [
      1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000, 30_000,
    ];

    for (const [attempt, delayMs] of expectedDelaysMs.entries()) {
      act(() => FakeWebSocket.instances[attempt].serverClose(WS_CLOSE_GOING_AWAY, true));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(delayMs - 1);
      });
      expect(FakeWebSocket.instances).toHaveLength(attempt + 1);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });
      expect(FakeWebSocket.instances).toHaveLength(attempt + 2);
    }
    act(() =>
      FakeWebSocket.instances[expectedDelaysMs.length].serverClose(WS_CLOSE_GOING_AWAY, true)
    );
    expect(rendered.result.current.connectionError).toBeNull();
    expect(rendered.result.current.reconnecting).toBe(true);
    rendered.unmount();
  });

  it("holds a retry while the tab is hidden and reconnects as soon as it is visible", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => FakeWebSocket.instances[0].open());

    setVisibility("hidden");
    act(() => FakeWebSocket.instances[0].serverClose(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    // Nobody can see a hidden tab, so it spends no attempts.
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rendered.result.current.reconnecting).toBe(true);

    setVisibility("visible");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);

    // The return restarts the backoff: a network still waking up after sleep
    // gets the 1s retry, not the 2s one the earlier close had earned.
    act(() => FakeWebSocket.instances[1].serverClose(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);
    rendered.unmount();
  });

  it("holds a retry while offline and reconnects when the network returns", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => FakeWebSocket.instances[0].open());

    setOnline(false);
    act(() => FakeWebSocket.instances[0].serverClose(1006));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(1);

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    rendered.unmount();
  });

  it("holds an armed retry when the browser goes offline before it fires", async () => {
    // 4002 drops the credential, so an attempt made offline would start with a
    // token mint that fails and strands the page behind an auth error.
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(4002, true);
    });

    setOnline(false);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(rendered.result.current.reconnecting).toBe(true);

    setOnline(true);
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(FakeWebSocket.instances).toHaveLength(2);
    rendered.unmount();
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

  it("resets retry backoff only after synchronization is healthy", async () => {
    vi.useFakeTimers();
    const rendered = renderTransport();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    act(() => {
      FakeWebSocket.instances[1].open();
      FakeWebSocket.instances[1].serverClose(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(3);

    act(() => {
      FakeWebSocket.instances[2].open();
      rendered.result.current.markHealthy();
      FakeWebSocket.instances[2].serverClose(1006);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(FakeWebSocket.instances).toHaveLength(4);
    rendered.unmount();
  });

  it("ignores a late close event from a socket replaced by reconnect", async () => {
    const { result, socket } = await openSocket();

    act(() => {
      result.current.reconnect();
    });
    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
    const replacement = FakeWebSocket.instances[1];
    act(() => {
      replacement.open();
    });
    await waitFor(() => {
      expect(result.current.connected).toBe(true);
    });

    // Browsers deliver close events asynchronously, so the discarded socket's
    // close can arrive after the replacement is live. It must not corrupt the
    // replacement's state or schedule a reconnect.
    act(() => {
      socket.onclose?.({ code: 1006, reason: "", wasClean: false } as CloseEvent);
    });

    expect(result.current.connected).toBe(true);
    expect(result.current.isOpen()).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("does not open a duplicate socket when reconnect() interrupts an in-flight token fetch", async () => {
    const resolvers: Array<(value: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => resolvers.push(resolve)));
    const { result } = renderTransport();
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.reconnect();
    });
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    // The stale fetch resolves first: the superseded connect must not open a
    // socket or store its token.
    await act(async () => {
      resolvers[0](Response.json({ token: "stale-token" }));
    });
    expect(FakeWebSocket.instances).toHaveLength(0);

    await act(async () => {
      resolvers[1](Response.json({ token: "fresh-token" }));
    });
    await waitFor(() => {
      expect(FakeWebSocket.instances).toHaveLength(1);
    });

    act(() => {
      FakeWebSocket.instances[0].open();
    });
    expect(FakeWebSocket.instances[0].sentMessages).toEqual([
      expect.objectContaining({ token: "fresh-token" }),
    ]);
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
