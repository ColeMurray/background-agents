import { describe, expect, it, vi } from "vitest";
import { DurableObjectSessionConnections } from "./durable-object-session-connections";
import type { SessionWebSocketManager } from "./websocket-manager";

vi.stubGlobal(
  "WebSocketRequestResponsePair",
  class WebSocketRequestResponsePair {
    constructor(
      readonly request: string,
      readonly response: string
    ) {}
  }
);

function harness() {
  const browser = { readyState: WebSocket.OPEN } as WebSocket;
  const sandbox = { readyState: WebSocket.OPEN } as WebSocket;
  const clientInfo = {
    participantId: "part-1",
    userId: "user-1",
    name: "Test User",
    status: "active" as const,
    lastSeen: 123,
    clientId: "client-1",
    ws: browser,
  };
  const manager = {
    classify: vi.fn((ws: WebSocket) =>
      ws === sandbox
        ? ({ kind: "sandbox" as const, sandboxId: "sb-1" } as const)
        : ({ kind: "client" as const, wsId: "ws-1" } as const)
    ),
    forEachClientSocket: vi.fn(
      (_mode: "all_clients" | "authenticated_only", fn: (ws: WebSocket) => void) => fn(browser)
    ),
    setClient: vi.fn(),
    persistClientMapping: vi.fn(),
    getSandboxSocket: vi.fn(() => sandbox),
    send: vi.fn(() => true),
    detachSandboxSocket: vi.fn(),
    getAuthenticatedClients: vi.fn(() => [clientInfo].values()),
    recoverClientMapping: vi.fn(() => null),
  } as unknown as SessionWebSocketManager;
  const state = { setWebSocketAutoResponse: vi.fn() } as unknown as DurableObjectState;
  return {
    connections: new DurableObjectSessionConnections(state, manager),
    manager,
    state,
    browser,
    sandbox,
  };
}

describe("DurableObjectSessionConnections", () => {
  it("owns Cloudflare auto-response configuration", () => {
    const { state } = harness();

    expect(state.setWebSocketAutoResponse).toHaveBeenCalledTimes(1);
  });

  it("registers and broadcasts to a browser through the WebSocket registry", async () => {
    const { connections, manager, browser } = harness();
    const input = {
      connectionId: "ws-1",
      clientId: "client-1",
      participant: {
        participantId: "part-1",
        userId: "user-1",
        name: "Test User",
        status: "active" as const,
        lastSeen: 123,
      },
    };

    await connections.registerBrowser(input);
    const message = { type: "sandbox_status", status: "ready" } as const;
    await connections.broadcastToBrowsers(message);

    expect(manager.setClient).toHaveBeenCalledWith(
      browser,
      expect.objectContaining(input.participant)
    );
    expect(manager.persistClientMapping).toHaveBeenCalledWith("ws-1", "part-1", "client-1");
    expect(manager.send).toHaveBeenCalledWith(browser, message);
  });

  it("sends to and disconnects the active sandbox", async () => {
    const { connections, manager, sandbox } = harness();

    await connections.registerSandbox({ connectionId: "sandbox-1", sandboxId: "sb-1" });
    await connections.sendToSandbox({ type: "snapshot" });
    await connections.disconnectSandbox({ code: 1011, reason: "Unresponsive sandbox" });

    expect(manager.send).toHaveBeenCalledWith(sandbox, { type: "snapshot" });
    expect(manager.detachSandboxSocket).toHaveBeenCalledWith(1011, "Unresponsive sandbox");
  });

  it("rejects registration for a different sandbox identity", async () => {
    const { connections } = harness();

    await expect(
      connections.registerSandbox({ connectionId: "sandbox-2", sandboxId: "sb-2" })
    ).rejects.toThrow("does not match");
  });

  it("lists participants without exposing WebSocket details", async () => {
    const { connections } = harness();

    await expect(connections.listParticipants()).resolves.toEqual([
      {
        participantId: "part-1",
        userId: "user-1",
        name: "Test User",
        status: "active",
        lastSeen: 123,
      },
    ]);
  });
});
