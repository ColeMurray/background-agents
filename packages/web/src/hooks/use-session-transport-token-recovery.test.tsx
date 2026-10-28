// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { FakeWebSocket } from "@/test/fake-session-websocket";
import { useSessionTransport } from "./use-session-transport";

const mintStages = [
  { stage: "initial", closeCode: null, firstDelayMs: 0, retryDelayMs: 1_000 },
  { stage: "4001 refresh", closeCode: 4001, firstDelayMs: 0, retryDelayMs: 1_000 },
  { stage: "4002 refresh", closeCode: 4002, firstDelayMs: 1_000, retryDelayMs: 2_000 },
  { stage: "4010 refresh", closeCode: 4010, firstDelayMs: 0, retryDelayMs: 1_000 },
] as const;

const transientFailures: Array<{ failure: string; mint: () => Promise<Response> }> = [
  { failure: "network rejection", mint: () => Promise.reject(new TypeError("Failed to fetch")) },
  { failure: "HTTP 429", mint: () => Promise.resolve(new Response(null, { status: 429 })) },
  { failure: "HTTP 503", mint: () => Promise.resolve(new Response(null, { status: 503 })) },
  { failure: "invalid JSON", mint: () => Promise.resolve(new Response("unavailable")) },
  { failure: "missing token", mint: () => Promise.resolve(Response.json({})) },
];

describe("useSessionTransport token recovery", () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let online: MockInstance<() => boolean>;
  const onMessage = vi.fn();

  function renderTransport() {
    return renderHook(
      ({ sessionId, enabled }) => useSessionTransport(sessionId, { onMessage }, enabled),
      { initialProps: { sessionId: "session-1", enabled: true } }
    );
  }

  async function advance(delayMs: number) {
    await act(async () => vi.advanceTimersByTimeAsync(delayMs));
  }

  async function resumeEvents() {
    act(() => {
      window.dispatchEvent(new Event("online"));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await advance(0);
  }

  async function renderMintAttempt(
    { closeCode, firstDelayMs }: (typeof mintStages)[number],
    mint: () => Promise<Response>
  ) {
    if (closeCode !== null) {
      fetchMock.mockResolvedValueOnce(Response.json({ token: "original-token" }));
    }
    fetchMock.mockImplementationOnce(mint);
    const rendered = renderTransport();
    await advance(0);
    if (closeCode !== null) {
      expect(FakeWebSocket.instances).toHaveLength(1);
      act(() => {
        FakeWebSocket.instances[0].open();
        FakeWebSocket.instances[0].serverClose(closeCode, true);
      });
      if (firstDelayMs > 0) {
        await advance(firstDelayMs - 1);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        await advance(1);
      } else {
        await advance(0);
      }
    }
    expect(fetchMock).toHaveBeenCalledTimes(closeCode === null ? 1 : 2);
    return rendered;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(crypto, "randomUUID").mockReturnValue("00000000-0000-0000-0000-000000000000");
    FakeWebSocket.instances = [];
    fetchMock = vi.fn<typeof fetch>(async () => Response.json({ token: "recovered-token" }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("WebSocket", FakeWebSocket);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  describe.each(mintStages)("$stage mint", (stage) => {
    it.each(transientFailures)(
      "recovers from $failure on the existing backoff",
      async ({ mint }) => {
        const { result } = await renderMintAttempt(stage, mint);
        const initialCalls = stage.closeCode === null ? 1 : 2;
        const initialSockets = stage.closeCode === null ? 0 : 1;
        expect(result.current).toMatchObject({
          authError: null,
          connectionError: null,
          sessionGone: false,
          connecting: false,
          reconnecting: true,
        });
        expect(FakeWebSocket.instances).toHaveLength(initialSockets);

        await advance(stage.retryDelayMs - 1);
        expect(fetchMock).toHaveBeenCalledTimes(initialCalls);
        expect(FakeWebSocket.instances).toHaveLength(initialSockets);
        await advance(1);
        expect(fetchMock).toHaveBeenCalledTimes(initialCalls + 1);
        expect(FakeWebSocket.instances).toHaveLength(initialSockets + 1);
        const recovered = FakeWebSocket.instances[initialSockets];
        act(() => recovered.open());
        expect(recovered.sentMessages).toEqual([
          expect.objectContaining({ type: "subscribe", token: "recovered-token" }),
        ]);
        expect(result.current.connected).toBe(true);
        expect(result.current.authError).toBeNull();
        expect(result.current.reconnecting).toBe(false);
      }
    );

    it.each([401, 403, 422, 404])("does not timer/event retry terminal HTTP %i", async (status) => {
      const { result, rerender } = await renderMintAttempt(stage, () =>
        Promise.resolve(new Response(null, { status }))
      );
      const initialCalls = stage.closeCode === null ? 1 : 2;
      expect(result.current).toMatchObject({
        connected: false,
        connecting: false,
        reconnecting: false,
        sessionGone: status === 404,
        authError: status === 404 ? null : expect.any(String),
      });
      if (status === 401) expect(result.current.authError).toBe("Please sign in to connect");
      if (status === 404) {
        act(() => result.current.reconnect());
        rerender({ sessionId: "session-1", enabled: false });
        rerender({ sessionId: "session-1", enabled: true });
      }
      await advance(60_000);
      await resumeEvents();
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(initialCalls);
      expect(FakeWebSocket.instances).toHaveLength(stage.closeCode === null ? 0 : 1);
      expect(result.current.reconnecting).toBe(false);
    });

    it.each(["disabled", "unmount", "session change"])(
      "cancels a pending token retry on %s",
      async (change) => {
        const rendered = await renderMintAttempt(stage, transientFailures[0].mint);
        expect(rendered.result.current.reconnecting).toBe(true);
        const initialCalls = fetchMock.mock.calls.length;
        if (change === "unmount") rendered.unmount();
        else {
          rendered.rerender({
            sessionId: change === "session change" ? "session-2" : "session-1",
            enabled: change !== "disabled",
          });
        }
        await advance(0);
        expect(vi.getTimerCount()).toBe(change === "session change" ? 1 : 0);
        await resumeEvents();
        await advance(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(
          initialCalls + (change === "session change" ? 1 : 0)
        );
        if (change === "session change") {
          expect(fetchMock).toHaveBeenLastCalledWith(
            "/api/sessions/session-2/ws-token",
            expect.any(Object)
          );
          expect(FakeWebSocket.instances.at(-1)?.url).toContain("/sessions/session-2/ws");
        }
      }
    );
  });

  it.each([401, 403, 404])(
    "revalidates cached admission after a failed upgrade and stops on HTTP %i",
    async (status) => {
      const { result } = renderTransport();
      await advance(0);
      act(() => {
        FakeWebSocket.instances[0].open();
        FakeWebSocket.instances[0].serverClose(1006);
      });
      await advance(1_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(FakeWebSocket.instances).toHaveLength(2);

      fetchMock.mockResolvedValue(new Response(null, { status }));
      act(() => FakeWebSocket.instances[1].serverClose(1006));
      await advance(2_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(result.current).toMatchObject({
        sessionGone: status === 404,
        authError: status === 404 ? null : expect.any(String),
        connecting: false,
        reconnecting: false,
      });
      await advance(300_000);
      await resumeEvents();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(FakeWebSocket.instances).toHaveLength(2);
    }
  );

  it("keeps backoff through transient admission failures and revalidates each failed upgrade", async () => {
    const { result } = renderTransport();
    await advance(0);
    act(() => {
      FakeWebSocket.instances[0].open();
      FakeWebSocket.instances[0].serverClose(1006);
    });
    await advance(1_000);
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ token: "revalidated-token" }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }));
    act(() => FakeWebSocket.instances[1].serverClose(1006));
    await advance(2_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.authError).toBeNull();
    expect(result.current.reconnecting).toBe(true);
    await advance(3_999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(FakeWebSocket.instances).toHaveLength(3);

    act(() => FakeWebSocket.instances[2].serverClose(1006));
    await advance(7_999);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await advance(1);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(FakeWebSocket.instances).toHaveLength(3);
    expect(result.current.sessionGone).toBe(true);
    expect(result.current.reconnecting).toBe(false);
  });

  it.each([
    { random: 0, delaysMs: [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000] },
    { random: 0.5, delaysMs: [750, 1_500, 3_000, 6_000, 12_000, 22_500, 22_500] },
    { random: 1, delaysMs: [500, 1_000, 2_000, 4_000, 8_000, 15_000, 15_000] },
  ])("jitters repeated transient mint delays with random=$random", async ({ random, delaysMs }) => {
    vi.mocked(Math.random).mockReturnValue(random);
    fetchMock.mockImplementation(transientFailures[2].mint);
    const { result } = renderTransport();
    await advance(0);
    for (const [attempt, delayMs] of delaysMs.entries()) {
      expect(result.current.authError).toBeNull();
      expect(result.current.reconnecting).toBe(true);
      await advance(delayMs - 1);
      expect(fetchMock).toHaveBeenCalledTimes(attempt + 1);
      await advance(1);
      expect(fetchMock).toHaveBeenCalledTimes(attempt + 2);
    }
    expect(FakeWebSocket.instances).toHaveLength(0);
    fetchMock.mockImplementation(async () => Response.json({ token: "recovered-token" }));
    await advance(30_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => FakeWebSocket.instances[0].open());
    expect(result.current.connected).toBe(true);
    expect(result.current.authError).toBeNull();
  });

  it.each(["mint", "socket"])(
    "holds hidden-tab %s retries until visible and online",
    async (source) => {
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      if (source === "mint") fetchMock.mockImplementationOnce(transientFailures[0].mint);
      const { result } = renderTransport();
      await advance(0);
      if (source === "socket") {
        act(() => {
          FakeWebSocket.instances[0].open();
          FakeWebSocket.instances[0].serverClose(1006);
        });
      }
      const initialCalls = fetchMock.mock.calls.length;
      const initialSockets = FakeWebSocket.instances.length;
      await advance(10 * 60_000);
      await resumeEvents();
      expect(fetchMock).toHaveBeenCalledTimes(initialCalls);
      expect(FakeWebSocket.instances).toHaveLength(initialSockets);
      expect(result.current.reconnecting).toBe(true);

      online.mockReturnValue(false);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await resumeEvents();
      expect(FakeWebSocket.instances).toHaveLength(initialSockets);
      expect(fetchMock).toHaveBeenCalledTimes(initialCalls);
      online.mockReturnValue(true);
      await resumeEvents();
      expect(FakeWebSocket.instances).toHaveLength(initialSockets + 1);
      expect(result.current.authError).toBeNull();
    }
  );

  it.each(["before scheduling", "after scheduling"])(
    "holds a token retry when offline %s and waits for visibility after network recovery",
    async (timing) => {
      if (timing === "before scheduling") online.mockReturnValue(false);
      fetchMock.mockImplementationOnce(transientFailures[0].mint);
      const { result } = renderTransport();
      await advance(0);
      online.mockReturnValue(false);
      await advance(60_000);
      await resumeEvents();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.current.reconnecting).toBe(true);
      expect(result.current.authError).toBeNull();
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
      online.mockReturnValue(true);
      await resumeEvents();
      await advance(60_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(FakeWebSocket.instances).toHaveLength(0);
      vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
      await resumeEvents();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(FakeWebSocket.instances).toHaveLength(1);
    }
  );

  describe.each(["reconnect", "session change", "disabled", "unmount"])(
    "a late mint after %s",
    (change) => {
      it.each(["network rejection", "HTTP 503"])("ignores a superseded %s", async (failure) => {
        let resolveOld!: (response: Response) => void;
        let rejectOld!: (reason: unknown) => void;
        fetchMock.mockImplementationOnce(
          () =>
            new Promise<Response>((resolve, reject) => {
              resolveOld = resolve;
              rejectOld = reject;
            })
        );
        const rendered = renderTransport();
        await advance(0);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        if (change === "reconnect") act(() => rendered.result.current.reconnect());
        else if (change === "unmount") rendered.unmount();
        else {
          rendered.rerender({
            sessionId: change === "session change" ? "session-2" : "session-1",
            enabled: change !== "disabled",
          });
        }
        await advance(0);
        const callsBeforeFailure = fetchMock.mock.calls.length;
        const timersBeforeFailure = vi.getTimerCount();
        await act(async () => {
          if (failure === "network rejection") rejectOld(new TypeError("Failed to fetch"));
          else resolveOld(new Response(null, { status: 503 }));
        });
        expect(vi.getTimerCount()).toBe(timersBeforeFailure);
        await resumeEvents();
        await advance(60_000);
        expect(fetchMock).toHaveBeenCalledTimes(callsBeforeFailure);
        expect(FakeWebSocket.instances).toHaveLength(callsBeforeFailure - 1);
        if (change !== "unmount") {
          expect(rendered.result.current.authError).toBeNull();
          expect(rendered.result.current.sessionGone).toBe(false);
          expect(rendered.result.current.reconnecting).toBe(false);
        }
      });
    }
  );
});
