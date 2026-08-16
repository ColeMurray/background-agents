import { describe, expect, it } from "vitest";
import { InMemorySessionConnections } from "./connections";
import { SessionMessengerImpl } from "./messenger";

const participant = {
  participantId: "participant-1",
  userId: "user-1",
  name: "Test User",
  status: "active" as const,
  lastSeen: 123,
};

describe("InMemorySessionConnections", () => {
  it("broadcasts only to registered browser connections", async () => {
    const connections = new InMemorySessionConnections();
    await connections.registerBrowser({
      connectionId: "browser-1",
      clientId: "client-1",
      participant,
    });

    const message = { type: "sandbox_status", status: "ready" } as const;
    await connections.broadcastToBrowsers(message);

    expect(connections.getBrowserMessages("browser-1")).toEqual([message]);
    expect(connections.getSandboxMessages()).toEqual([]);
  });

  it("replaces the active sandbox connection and delivers to the replacement", async () => {
    const connections = new InMemorySessionConnections();
    await connections.registerSandbox({ connectionId: "sandbox-1", sandboxId: "sb-1" });
    await connections.sendToSandbox({ type: "snapshot" });
    await connections.registerSandbox({ connectionId: "sandbox-2", sandboxId: "sb-2" });
    await connections.sendToSandbox({ type: "refresh_diff" });

    expect(connections.getSandboxMessages("sandbox-1")).toEqual([{ type: "snapshot" }]);
    expect(connections.getSandboxMessages("sandbox-2")).toEqual([{ type: "refresh_diff" }]);
  });

  it("lists connected participants without exposing transport details", async () => {
    const connections = new InMemorySessionConnections();
    await connections.registerBrowser({
      connectionId: "browser-1",
      clientId: "client-1",
      participant,
    });

    await expect(connections.listParticipants()).resolves.toEqual([participant]);
  });

  it("records the sandbox disconnect reason and rejects later delivery", async () => {
    const connections = new InMemorySessionConnections();
    await connections.registerSandbox({ connectionId: "sandbox-1", sandboxId: "sb-1" });

    const reason = { code: 1011, reason: "Unresponsive sandbox" };
    await connections.disconnectSandbox(reason);

    expect(connections.getSandboxDisconnect("sandbox-1")).toEqual(reason);
    await expect(connections.sendToSandbox({ type: "stop" })).rejects.toThrow(
      "No sandbox connected"
    );
  });
});

describe("SessionMessengerImpl with in-memory connections", () => {
  it("can exercise engine messaging without WebSocket globals", async () => {
    const connections = new InMemorySessionConnections();
    await connections.registerBrowser({
      connectionId: "browser-1",
      clientId: "client-1",
      participant,
    });
    await connections.registerSandbox({ connectionId: "sandbox-1", sandboxId: "sb-1" });
    const messenger = new SessionMessengerImpl(connections);

    const browserMessage = {
      type: "diff_state_changed",
      revisionId: "revision-1",
      updatedAt: 1,
    } as const;
    messenger.broadcast(browserMessage);
    await messenger.sendToSandbox({ type: "refresh_diff" });
    await connections.flush();

    expect(connections.getBrowserMessages("browser-1")).toEqual([browserMessage]);
    expect(connections.getSandboxMessages()).toEqual([{ type: "refresh_diff" }]);
  });
});
