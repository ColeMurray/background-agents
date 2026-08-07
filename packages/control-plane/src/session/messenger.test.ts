import { describe, expect, it, vi } from "vitest";
import { SessionMessengerImpl } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { SessionDelta } from "@open-inspect/shared/types/server-messages";

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

  it("dual-encodes canonical mutations for V1 and V2 sockets", () => {
    const v1 = {} as WebSocket;
    const v2 = {} as WebSocket;
    const send = vi.fn((_ws: WebSocket, _message: unknown) => true);
    const advanceClientViewRevision = vi.fn();
    const wsManager = {
      forEachClientSocket: vi.fn(
        (_mode: "all_clients" | "authenticated_only", fn: (ws: WebSocket) => void) => {
          fn(v1);
          fn(v2);
        }
      ),
      getClientViewState: vi.fn((ws: WebSocket) =>
        ws === v1
          ? { wsId: "v1", viewProtocol: 1, appliedViewRevision: 0 }
          : { wsId: "v2", viewProtocol: 2, appliedViewRevision: 0 }
      ),
      send,
      advanceClientViewRevision,
      close: vi.fn(),
    } as unknown as SessionWebSocketManager;
    const delta: SessionDelta = {
      operations: [{ type: "state_patch", patch: { title: "New" } }],
    };
    const repository = {
      getCurrentViewRevision: () => 1,
      readContiguousSessionViewDeltas: () => [{ revision: 1, delta, createdAt: 1 }],
    };
    const messenger = new SessionMessengerImpl(wsManager, repository);

    messenger.broadcast({ type: "session_title", title: "New" });

    expect(send).toHaveBeenCalledWith(v1, { type: "session_title", title: "New" });
    expect(send).toHaveBeenCalledWith(v2, { type: "session_delta", revision: 1, delta });
    expect(send.mock.calls).toHaveLength(2);
    expect(send.mock.calls[0][0]).toBe(v1);
    expect(send.mock.calls[1][0]).toBe(v2);
    expect(advanceClientViewRevision).toHaveBeenCalledWith(v2, 1);
  });

  it("never sends sandbox access credentials to V2 sockets", () => {
    const ws = {} as WebSocket;
    const send = vi.fn((_ws: WebSocket, _message: unknown) => true);
    const wsManager = {
      forEachClientSocket: vi.fn(
        (_mode: "all_clients" | "authenticated_only", fn: (socket: WebSocket) => void) => fn(ws)
      ),
      getClientViewState: () => ({
        wsId: "v2",
        viewProtocol: 2 as const,
        appliedViewRevision: 0,
      }),
      send,
      close: vi.fn(),
    } as unknown as SessionWebSocketManager;
    const repository = {
      getCurrentViewRevision: () => 0,
      readContiguousSessionViewDeltas: () => [],
    };
    const messenger = new SessionMessengerImpl(wsManager, repository);

    messenger.broadcast({ type: "code_server_info", url: "https://code", password: "secret" });
    messenger.broadcast({ type: "ttyd_info", url: "https://ttyd", token: "secret" });

    expect(send).not.toHaveBeenCalled();
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
