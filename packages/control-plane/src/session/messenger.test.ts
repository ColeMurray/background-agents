import { describe, expect, it, vi } from "vitest";
import { SandboxDeliveryUnavailableError, SessionMessengerImpl } from "./messenger";

function harness(overrides: { sandboxSocket?: WebSocket | null; sendResult?: boolean } = {}) {
  const clientA = { readyState: WebSocket.OPEN } as WebSocket;
  const clientB = { readyState: WebSocket.OPEN } as WebSocket;
  const sandbox =
    overrides.sandboxSocket === undefined
      ? ({ readyState: WebSocket.OPEN } as WebSocket)
      : overrides.sandboxSocket;
  const wsManager = {
    forEachClientSocket: vi.fn(
      (_mode: "all_clients" | "authenticated_only", fn: (ws: WebSocket) => void) => {
        fn(clientA);
        fn(clientB);
      }
    ),
    getSandboxSocket: vi.fn(() => sandbox),
    send: vi.fn(() => overrides.sendResult ?? true),
  };
  return { messenger: new SessionMessengerImpl(wsManager), wsManager, clientA, clientB, sandbox };
}

describe("SessionMessengerImpl", () => {
  it("broadcasts to every authenticated client socket", () => {
    const { messenger, wsManager, clientA, clientB } = harness();
    const message = { type: "diff_state_changed", revisionId: "r1", updatedAt: 1 } as const;

    messenger.broadcast(message);

    expect(wsManager.forEachClientSocket).toHaveBeenCalledWith(
      "authenticated_only",
      expect.any(Function)
    );
    expect(wsManager.send).toHaveBeenCalledWith(clientA, message);
    expect(wsManager.send).toHaveBeenCalledWith(clientB, message);
  });

  it("sends a command to the connected sandbox socket", async () => {
    const { messenger, wsManager, sandbox } = harness();

    await messenger.sendToSandbox({ type: "refresh_diff" });

    expect(wsManager.send).toHaveBeenCalledWith(sandbox, { type: "refresh_diff" });
  });

  it("rejects with SandboxDeliveryUnavailableError when no sandbox is connected", async () => {
    const { messenger } = harness({ sandboxSocket: null });

    await expect(messenger.sendToSandbox({ type: "refresh_diff" })).rejects.toThrow(
      SandboxDeliveryUnavailableError
    );
    await expect(messenger.sendToSandbox({ type: "refresh_diff" })).rejects.toThrow(
      "No sandbox connected"
    );
  });

  it("rejects when the registry cannot deliver to the sandbox socket", async () => {
    const { messenger } = harness({ sendResult: false });

    await expect(messenger.sendToSandbox({ type: "refresh_diff" })).rejects.toThrow(
      "Failed to send message to sandbox"
    );
  });
});
