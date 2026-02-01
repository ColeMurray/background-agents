/**
 * Tests for PresenceManager service.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { createPresenceManager } from "./presence-manager";
import type { PresenceManager } from "./types";
import type { ClientInfo } from "../../types";

// Mock WebSocket for testing
class MockWebSocket {
  readyState = 1; // OPEN
  static OPEN = 1;
  static CLOSED = 3;

  send = vi.fn();
  close = vi.fn();
}

describe("PresenceManager", () => {
  let manager: PresenceManager;
  let mockBroadcast: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockBroadcast = vi.fn();
    manager = createPresenceManager({ broadcast: mockBroadcast });
  });

  describe("buildPresenceList", () => {
    it("should build empty presence list from empty clients map", () => {
      const clients = new Map<WebSocket, ClientInfo>();

      const presence = manager.buildPresenceList(clients);

      expect(presence).toEqual([]);
    });

    it("should build presence list from single client", () => {
      const clients = new Map<WebSocket, ClientInfo>();
      const ws = new MockWebSocket() as unknown as WebSocket;
      clients.set(ws, {
        participantId: "participant-1",
        clientId: "client-1",
      });

      const presence = manager.buildPresenceList(clients);

      expect(presence).toEqual([
        {
          participantId: "participant-1",
          clientId: "client-1",
        },
      ]);
    });

    it("should build presence list from multiple clients", () => {
      const clients = new Map<WebSocket, ClientInfo>();
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;

      clients.set(ws1, { participantId: "p1", clientId: "c1" });
      clients.set(ws2, { participantId: "p2", clientId: "c2" });

      const presence = manager.buildPresenceList(clients);

      expect(presence).toHaveLength(2);
      expect(presence).toContainEqual({ participantId: "p1", clientId: "c1" });
      expect(presence).toContainEqual({ participantId: "p2", clientId: "c2" });
    });

    it("should handle clients with same participant but different client IDs", () => {
      const clients = new Map<WebSocket, ClientInfo>();
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;

      clients.set(ws1, { participantId: "p1", clientId: "c1" });
      clients.set(ws2, { participantId: "p1", clientId: "c2" });

      const presence = manager.buildPresenceList(clients);

      expect(presence).toHaveLength(2);
      expect(presence).toContainEqual({ participantId: "p1", clientId: "c1" });
      expect(presence).toContainEqual({ participantId: "p1", clientId: "c2" });
    });
  });

  describe("broadcastPresence", () => {
    it("should broadcast presence update with empty list", () => {
      const clients = new Map<WebSocket, ClientInfo>();

      manager.broadcastPresence(clients);

      expect(mockBroadcast).toHaveBeenCalledTimes(1);
      expect(mockBroadcast).toHaveBeenCalledWith({
        type: "presence",
        participants: [],
      });
    });

    it("should broadcast presence update with single client", () => {
      const clients = new Map<WebSocket, ClientInfo>();
      const ws = new MockWebSocket() as unknown as WebSocket;
      clients.set(ws, { participantId: "p1", clientId: "c1" });

      manager.broadcastPresence(clients);

      expect(mockBroadcast).toHaveBeenCalledWith({
        type: "presence",
        participants: [{ participantId: "p1", clientId: "c1" }],
      });
    });

    it("should broadcast presence update with multiple clients", () => {
      const clients = new Map<WebSocket, ClientInfo>();
      const ws1 = new MockWebSocket() as unknown as WebSocket;
      const ws2 = new MockWebSocket() as unknown as WebSocket;

      clients.set(ws1, { participantId: "p1", clientId: "c1" });
      clients.set(ws2, { participantId: "p2", clientId: "c2" });

      manager.broadcastPresence(clients);

      const call = mockBroadcast.mock.calls[0][0];
      expect(call.type).toBe("presence");
      expect(call.participants).toHaveLength(2);
    });

    it("should not throw if broadcast fails", () => {
      const clients = new Map<WebSocket, ClientInfo>();
      const ws = new MockWebSocket() as unknown as WebSocket;
      clients.set(ws, { participantId: "p1", clientId: "c1" });

      mockBroadcast.mockImplementation(() => {
        throw new Error("Broadcast failed");
      });

      expect(() => manager.broadcastPresence(clients)).not.toThrow();
    });
  });
});
