/**
 * Tests for WebSocketManager service.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createWebSocketManager } from "./websocket-manager";
import type { WebSocketManager } from "./types";
import type { ClientInfo } from "../../types";

// Mock WebSocket for testing
class MockWebSocket {
  readyState = 1; // OPEN
  static OPEN = 1;
  static CLOSED = 3;

  send = vi.fn();
  close = vi.fn();
}

function createClientInfo(overrides: Partial<ClientInfo> = {}): ClientInfo {
  const ws = overrides.ws ?? (new MockWebSocket() as unknown as WebSocket);
  return {
    participantId: "participant-1",
    userId: "user-1",
    name: "User 1",
    status: "active",
    lastSeen: Date.now(),
    clientId: "client-1",
    ws,
    ...overrides,
  };
}

describe("WebSocketManager", () => {
  let manager: WebSocketManager;

  beforeEach(() => {
    manager = createWebSocketManager();
  });

  describe("client management", () => {
    it("should register a client", () => {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const clientInfo = createClientInfo({ ws });

      manager.registerClient(ws, clientInfo);

      const clients = manager.getClients();
      expect(clients.size).toBe(1);
      expect(clients.get(ws)).toEqual(clientInfo);
    });

    it("should remove a client", () => {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const clientInfo = createClientInfo({ ws });

      manager.registerClient(ws, clientInfo);
      manager.removeClient(ws);

      const clients = manager.getClients();
      expect(clients.size).toBe(0);
    });

    it("should register multiple clients", () => {
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;

      manager.registerClient(
        ws1,
        createClientInfo({ participantId: "p1", clientId: "c1", ws: ws1 })
      );
      manager.registerClient(
        ws2,
        createClientInfo({ participantId: "p2", clientId: "c2", ws: ws2 })
      );

      expect(manager.getClients().size).toBe(2);
    });
  });

  describe("sandbox WebSocket", () => {
    it("should set sandbox WebSocket", () => {
      const ws = new MockWebSocket() as unknown as WebSocket;

      manager.setSandboxWebSocket(ws);

      expect(manager.getSandboxWebSocket()).toBe(ws);
    });

    it("should clear sandbox WebSocket", () => {
      const ws = new MockWebSocket() as unknown as WebSocket;

      manager.setSandboxWebSocket(ws);
      manager.setSandboxWebSocket(null);

      expect(manager.getSandboxWebSocket()).toBeNull();
    });
  });

  describe("safeSend", () => {
    it("should send message when WebSocket is open", () => {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message = { type: "test", data: "hello" };

      const result = manager.safeSend(ws, message);

      expect(result).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it("should not send when WebSocket is closed", () => {
      const ws = new MockWebSocket() as unknown as WebSocket;
      (ws as unknown as { readyState: number }).readyState = MockWebSocket.CLOSED;
      const message = { type: "test" };

      const result = manager.safeSend(ws, message);

      expect(result).toBe(false);
      expect(ws.send).not.toHaveBeenCalled();
    });

    it("should handle send errors gracefully", () => {
      const ws = new MockWebSocket() as unknown as WebSocket;
      ws.send = vi.fn().mockImplementation(() => {
        throw new Error("Send failed");
      });
      const message = { type: "test" };

      const result = manager.safeSend(ws, message);

      expect(result).toBe(false);
    });

    it("should send string messages directly", () => {
      const ws = new MockWebSocket() as unknown as WebSocket;
      const message = "test message";

      const result = manager.safeSend(ws, message);

      expect(result).toBe(true);
      expect(ws.send).toHaveBeenCalledWith(message);
    });
  });

  describe("broadcast", () => {
    it("should broadcast to all registered clients", () => {
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;

      manager.registerClient(
        ws1,
        createClientInfo({ participantId: "p1", clientId: "c1", ws: ws1 })
      );
      manager.registerClient(
        ws2,
        createClientInfo({ participantId: "p2", clientId: "c2", ws: ws2 })
      );

      const message = { type: "test_event", data: "broadcast" };
      manager.broadcast(message);

      expect(ws1.send).toHaveBeenCalledWith(JSON.stringify(message));
      expect(ws2.send).toHaveBeenCalledWith(JSON.stringify(message));
    });

    it("should skip closed connections during broadcast", () => {
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;
      (ws2 as unknown as { readyState: number }).readyState = MockWebSocket.CLOSED;

      manager.registerClient(
        ws1,
        createClientInfo({ participantId: "p1", clientId: "c1", ws: ws1 })
      );
      manager.registerClient(
        ws2,
        createClientInfo({ participantId: "p2", clientId: "c2", ws: ws2 })
      );

      const message = { type: "test_event" };
      manager.broadcast(message);

      expect(ws1.send).toHaveBeenCalled();
      expect(ws2.send).not.toHaveBeenCalled();
    });

    it("should handle broadcast errors gracefully", () => {
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;
      ws1.send = vi.fn().mockImplementation(() => {
        throw new Error("Send failed");
      });

      manager.registerClient(
        ws1,
        createClientInfo({ participantId: "p1", clientId: "c1", ws: ws1 })
      );
      manager.registerClient(
        ws2,
        createClientInfo({ participantId: "p2", clientId: "c2", ws: ws2 })
      );

      const message = { type: "test_event" };
      // Should not throw
      expect(() => manager.broadcast(message)).not.toThrow();

      // ws2 should still receive the message
      expect(ws2.send).toHaveBeenCalled();
    });

    it("should not broadcast to empty client list", () => {
      const message = { type: "test_event" };

      // Should not throw
      expect(() => manager.broadcast(message)).not.toThrow();
    });
  });
});
