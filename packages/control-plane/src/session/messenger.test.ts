import { describe, expect, it, vi } from "vitest";
import { serverMessageSchema } from "@open-inspect/shared/types/server-messages";
import type { SessionWebSocket } from "../platform-ports";
import type { SandboxRow } from "./types";
import type { SessionWebSocketManager } from "./websocket-manager";
import { SessionMessengerImpl } from "./messenger";

describe("SessionMessenger bridge health compatibility", () => {
  function setup() {
    const socket: SessionWebSocket = { readyState: 1, send: vi.fn(), close: vi.fn() };
    const sockets = {
      forEachClientSocket: vi.fn<SessionWebSocketManager["forEachClientSocket"]>((_mode, visit) =>
        visit(socket)
      ),
      send: vi.fn<SessionWebSocketManager["send"]>(() => true),
      getSandboxCommandTarget: vi.fn<SessionWebSocketManager["getSandboxCommandTarget"]>(() => ({
        kind: "unavailable",
      })),
    };
    const repository = {
      getSandbox: vi.fn((): SandboxRow | null => ({ status: "ready" }) as SandboxRow),
    };
    return {
      socket,
      sockets,
      repository,
      messenger: new SessionMessengerImpl(sockets, repository),
    };
  }

  it.each(["connected", "reconnecting"] as const)(
    "sends %s using the existing discriminator",
    (connectionStatus) => {
      const h = setup();
      h.messenger.broadcast({ type: "sandbox_connection", status: connectionStatus });
      expect(h.sockets.forEachClientSocket).toHaveBeenCalledWith(
        "authenticated_only",
        expect.any(Function)
      );
      expect(h.sockets.send).toHaveBeenCalledExactlyOnceWith(h.socket, {
        type: "sandbox_status",
        status: "ready",
        connectionStatus,
      });
      expect(serverMessageSchema.parse(h.sockets.send.mock.calls[0][1])).toEqual({
        type: "sandbox_status",
        status: "ready",
        connectionStatus,
      });
    }
  );

  it("reads the current lifecycle state rather than reporting ready for every heartbeat", () => {
    const h = setup();
    h.repository.getSandbox.mockReturnValue({ status: "connecting" } as SandboxRow);
    h.messenger.broadcast({ type: "sandbox_connection", status: "connected" });
    expect(h.sockets.send).toHaveBeenCalledExactlyOnceWith(h.socket, {
      type: "sandbox_status",
      status: "connecting",
      connectionStatus: "connected",
    });
  });

  it("does not manufacture lifecycle state when the sandbox is absent", () => {
    const h = setup();
    h.repository.getSandbox.mockReturnValue(null);
    h.messenger.broadcast({ type: "sandbox_connection", status: "connected" });
    expect(h.sockets.send).not.toHaveBeenCalled();
  });

  it("passes ordinary lifecycle messages through unchanged", () => {
    const h = setup();
    h.messenger.broadcast({ type: "sandbox_status", status: "failed" });
    expect(h.sockets.send).toHaveBeenCalledExactlyOnceWith(h.socket, {
      type: "sandbox_status",
      status: "failed",
    });
    expect(h.repository.getSandbox).not.toHaveBeenCalled();
  });
});
