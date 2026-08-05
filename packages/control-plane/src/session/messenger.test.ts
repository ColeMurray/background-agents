import { describe, expect, it, vi } from "vitest";
import { SessionMessengerImpl } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";

function harness(sandboxSocket: WebSocket | null = null) {
  const clientSockets = [{} as WebSocket, {} as WebSocket];
  const send = vi.fn(() => true);
  const wsManager = {
    forEachClientSocket: vi.fn(
      (_mode: "all_clients" | "authenticated_only", fn: (ws: WebSocket) => void) => {
        for (const ws of clientSockets) fn(ws);
      }
    ),
    getSandboxSocket: vi.fn(() => sandboxSocket),
    send,
  } as unknown as SessionWebSocketManager;
  return { messenger: new SessionMessengerImpl(wsManager), wsManager, clientSockets, send };
}

describe("SessionMessengerImpl", () => {
  it("broadcasts to every authenticated client socket", () => {
    const { messenger, wsManager, clientSockets, send } = harness();
    const message = { type: "diff_state_changed", revisionId: "r1", updatedAt: 1 } as const;

    messenger.broadcast(message);

    expect(wsManager.forEachClientSocket).toHaveBeenCalledWith(
      "authenticated_only",
      expect.any(Function)
    );
    expect(send).toHaveBeenCalledTimes(clientSockets.length);
    for (const ws of clientSockets) expect(send).toHaveBeenCalledWith(ws, message);
  });

  it("sends a command to the connected sandbox socket", () => {
    const sandboxSocket = {} as WebSocket;
    const { messenger, send } = harness(sandboxSocket);

    expect(messenger.sendToSandbox({ type: "refresh_diff" })).toBe(true);
    expect(send).toHaveBeenCalledWith(sandboxSocket, { type: "refresh_diff" });
  });

  it("reports failure when no sandbox is connected", () => {
    const { messenger, send } = harness(null);

    expect(messenger.sendToSandbox({ type: "refresh_diff" })).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });
});
