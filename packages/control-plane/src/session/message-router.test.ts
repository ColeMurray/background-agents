import { describe, expect, it, vi } from "vitest";
import type { Logger } from "../logger";
import { SessionMessageRouter, type SessionClientCommands } from "./message-router";
import type { Clock, SocketRegistry } from "./ports";

interface TestClient {
  participantId: string;
  userId: string;
  lastFetchHistoryAtMs?: number;
}

function createHarness() {
  const client: TestClient = { participantId: "participant-1", userId: "user-1" };
  let now = 1000;
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  const clock: Clock = {
    nowMs: () => now,
    monotonicNowMs: vi.fn(() => now),
  };
  const sockets: SocketRegistry<string, TestClient> = {
    classify: vi.fn(() => ({ kind: "client" as const, wsId: "ws-1" })),
    send: vi.fn(() => true),
    getClient: vi.fn(() => client),
    close: vi.fn(),
    isActiveSandbox: vi.fn(() => true),
    clearSandboxIfMatch: vi.fn(() => true),
    removeClient: vi.fn(() => client),
    hasParticipant: vi.fn(() => false),
  };
  const clientCommands: SessionClientCommands<string, TestClient> = {
    subscribe: vi.fn(async () => undefined),
    submitPrompt: vi.fn(async () => undefined),
    cancelPrompt: vi.fn(async () => undefined),
    stopExecution: vi.fn(async () => undefined),
    recoverShutdown: vi.fn(async () => undefined),
    notifyTyping: vi.fn(async () => undefined),
    updatePresence: vi.fn(),
    getHistoryPage: vi.fn(() => ({ items: [], hasMore: false, cursor: null })),
    authorize: vi.fn(async () => "allowed" as const),
  };
  return {
    router: new SessionMessageRouter({
      log,
      sockets,
      clientCommands,
      processSandboxEvent: vi.fn(async () => undefined),
      clock,
    }),
    client,
    clientCommands,
    sockets,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("SessionMessageRouter", () => {
  it("preserves request correlation when a cancel prompt payload fails validation", async () => {
    const { router, sockets, clientCommands } = createHarness();

    await router.route(
      "client",
      JSON.stringify({ type: "cancel_prompt", messageId: "", clientRequestId: "cancel-1" })
    );

    expect(clientCommands.cancelPrompt).not.toHaveBeenCalled();
    expect(sockets.send).toHaveBeenCalledWith("client", {
      type: "error",
      code: "INVALID_MESSAGE",
      message: "Failed to process message",
      clientRequestId: "cancel-1",
    });
  });

  it("rejects fetch-history requests without a cursor without consuming the throttle window", async () => {
    const { router, client, clientCommands, sockets, setNow } = createHarness();
    const cursor = { timestamp: 10, id: "event-1", sequence: 2 };

    setNow(2000);
    await router.route("client", JSON.stringify({ type: "fetch_history" }));
    await router.route("client", JSON.stringify({ type: "fetch_history", cursor }));

    expect(client.lastFetchHistoryAtMs).toBe(2000);
    expect(clientCommands.getHistoryPage).toHaveBeenCalledExactlyOnceWith({ cursor });
    expect(sockets.send).toHaveBeenNthCalledWith(1, "client", {
      type: "error",
      code: "INVALID_CURSOR",
      message: "Invalid cursor",
    });
    expect(sockets.send).toHaveBeenNthCalledWith(2, "client", {
      type: "history_page",
      items: [],
      hasMore: false,
      cursor: null,
    });
  });
});
