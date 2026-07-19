import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Logger } from "../logger";
import type { ClientInfo } from "../types";
import { PresenceService, type PresenceServiceDeps } from "./presence-service";

// ---- Mock factories ----

function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

function createMockClient(overrides?: Partial<ClientInfo>): ClientInfo {
  return {
    participantId: "part-1",
    userId: "user-1",
    name: "Test User",
    avatar: "https://example.com/avatar.png",
    status: "active",
    lastSeen: 1000,
    clientId: "client-1",
    ws: {} as WebSocket,
    ...overrides,
  };
}

function createTestHarness() {
  const log = createMockLogger();
  const clients: ClientInfo[] = [];

  const deps: PresenceServiceDeps = {
    getAuthenticatedClients: vi.fn(() => clients.values()),
    getClientInfo: vi.fn(() => null),
    messenger: { broadcast: vi.fn(), sendToSandbox: vi.fn(() => true) },
    send: vi.fn(() => true),
    getSandboxSocket: vi.fn(() => null),
    isSpawning: vi.fn(() => false),
    spawnSandbox: vi.fn(async () => {}),
    log,
  };

  return {
    service: new PresenceService(deps),
    deps,
    clients,
    log,
  };
}

// ---- Tests ----

describe("PresenceService", () => {
  let harness: ReturnType<typeof createTestHarness>;

  beforeEach(() => {
    harness = createTestHarness();
  });

  describe("getPresenceList", () => {
    it("returns mapped ParticipantPresence array from authenticated clients", () => {
      const client1 = createMockClient({
        participantId: "part-1",
        userId: "user-1",
        name: "Alice",
        avatar: "https://example.com/alice.png",
        status: "active",
        lastSeen: 2000,
      });
      const client2 = createMockClient({
        participantId: "part-2",
        userId: "user-2",
        name: "Bob",
        avatar: "https://example.com/bob.png",
        status: "idle",
        lastSeen: 3000,
      });
      harness.clients.push(client1, client2);

      const result = harness.service.getPresenceList();

      expect(result).toEqual([
        {
          participantId: "part-1",
          userId: "user-1",
          name: "Alice",
          avatar: "https://example.com/alice.png",
          status: "active",
          lastSeen: 2000,
        },
        {
          participantId: "part-2",
          userId: "user-2",
          name: "Bob",
          avatar: "https://example.com/bob.png",
          status: "idle",
          lastSeen: 3000,
        },
      ]);
    });

    it("returns empty array when no clients", () => {
      const result = harness.service.getPresenceList();
      expect(result).toEqual([]);
    });

    it("dedupes by participantId when the same user is connected on multiple sockets", () => {
      // Same user connected from two tabs → two ClientInfo entries sharing one participantId.
      // Presence should report the participant exactly once so the UI doesn't render
      // duplicate avatars / log a React duplicate-key warning.
      const tab1 = createMockClient({
        participantId: "part-1",
        userId: "user-1",
        name: "Alice",
        status: "idle",
        lastSeen: 1000,
        clientId: "client-tab-1",
      });
      const tab2 = createMockClient({
        participantId: "part-1",
        userId: "user-1",
        name: "Alice",
        status: "active",
        lastSeen: 5000,
        clientId: "client-tab-2",
      });
      harness.clients.push(tab1, tab2);

      const result = harness.service.getPresenceList();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        participantId: "part-1",
        userId: "user-1",
        name: "Alice",
        avatar: "https://example.com/avatar.png",
        // any socket being active → participant is active
        status: "active",
        // most recent socket activity wins
        lastSeen: 5000,
      });
    });

    it("keeps distinct participants distinct while deduping shared ones", () => {
      const aliceTab1 = createMockClient({
        participantId: "part-1",
        userId: "user-1",
        name: "Alice",
        status: "idle",
        lastSeen: 1000,
      });
      const aliceTab2 = createMockClient({
        participantId: "part-1",
        userId: "user-1",
        name: "Alice",
        status: "active",
        lastSeen: 2000,
      });
      const bob = createMockClient({
        participantId: "part-2",
        userId: "user-2",
        name: "Bob",
        status: "idle",
        lastSeen: 3000,
      });
      harness.clients.push(aliceTab1, aliceTab2, bob);

      const result = harness.service.getPresenceList();

      expect(result).toHaveLength(2);
      const ids = result.map((p) => p.participantId).sort();
      expect(ids).toEqual(["part-1", "part-2"]);
    });
  });

  describe("sendPresence", () => {
    it("sends presence_sync message to specific WebSocket", () => {
      const client = createMockClient();
      harness.clients.push(client);
      const ws = {} as WebSocket;

      harness.service.sendPresence(ws);

      expect(harness.deps.send).toHaveBeenCalledWith(ws, {
        type: "presence_sync",
        participants: [
          {
            participantId: "part-1",
            userId: "user-1",
            name: "Test User",
            avatar: "https://example.com/avatar.png",
            status: "active",
            lastSeen: 1000,
          },
        ],
      });
    });
  });

  describe("broadcastPresence", () => {
    it("broadcasts presence_update to all clients", () => {
      const client = createMockClient();
      harness.clients.push(client);

      harness.service.broadcastPresence();

      expect(harness.deps.messenger.broadcast).toHaveBeenCalledWith({
        type: "presence_update",
        participants: [
          {
            participantId: "part-1",
            userId: "user-1",
            name: "Test User",
            avatar: "https://example.com/avatar.png",
            status: "active",
            lastSeen: 1000,
          },
        ],
      });
    });
  });

  describe("updatePresence", () => {
    it("updates client status/lastSeen and broadcasts", () => {
      const client = createMockClient({ status: "active", lastSeen: 1000 });
      vi.mocked(harness.deps.getClientInfo).mockReturnValue(client);
      const ws = {} as WebSocket;

      harness.service.updatePresence(ws, { status: "idle" });

      expect(client.status).toBe("idle");
      expect(client.lastSeen).toBeGreaterThan(1000);
      expect(harness.deps.messenger.broadcast).toHaveBeenCalled();
    });

    it("skips when client not found (no broadcast)", () => {
      vi.mocked(harness.deps.getClientInfo).mockReturnValue(null);
      const ws = {} as WebSocket;

      harness.service.updatePresence(ws, { status: "idle" });

      expect(harness.deps.messenger.broadcast).not.toHaveBeenCalled();
    });
  });

  describe("handleTyping", () => {
    it("spawns sandbox when no sandbox socket and not spawning", async () => {
      vi.mocked(harness.deps.getSandboxSocket).mockReturnValue(null);
      vi.mocked(harness.deps.isSpawning).mockReturnValue(false);

      await harness.service.handleTyping();

      expect(harness.deps.messenger.broadcast).toHaveBeenCalledWith({ type: "sandbox_warming" });
      expect(harness.deps.spawnSandbox).toHaveBeenCalled();
    });

    it("broadcasts sandbox_warming before spawning", async () => {
      vi.mocked(harness.deps.getSandboxSocket).mockReturnValue(null);
      vi.mocked(harness.deps.isSpawning).mockReturnValue(false);

      const callOrder: string[] = [];
      vi.mocked(harness.deps.messenger.broadcast).mockImplementation(() => {
        callOrder.push("broadcast");
      });
      vi.mocked(harness.deps.spawnSandbox).mockImplementation(async () => {
        callOrder.push("spawn");
      });

      await harness.service.handleTyping();

      expect(callOrder).toEqual(["broadcast", "spawn"]);
    });

    it("skips when already spawning", async () => {
      vi.mocked(harness.deps.getSandboxSocket).mockReturnValue(null);
      vi.mocked(harness.deps.isSpawning).mockReturnValue(true);

      await harness.service.handleTyping();

      expect(harness.deps.messenger.broadcast).not.toHaveBeenCalled();
      expect(harness.deps.spawnSandbox).not.toHaveBeenCalled();
    });

    it("skips when sandbox already connected", async () => {
      vi.mocked(harness.deps.getSandboxSocket).mockReturnValue({} as WebSocket);

      await harness.service.handleTyping();

      expect(harness.deps.messenger.broadcast).not.toHaveBeenCalled();
      expect(harness.deps.spawnSandbox).not.toHaveBeenCalled();
    });
  });
});
