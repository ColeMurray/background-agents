/**
 * Unit tests for SessionWebSocketManagerImpl.
 *
 * Uses fake DurableObjectState and mock SessionRepository to test
 * all WebSocket mechanics in isolation from the full DO.
 */

import { describe, it, expect, vi } from "vitest";
import { SessionWebSocketManagerImpl } from "./websocket-manager";
import type { WebSocketManagerConfig } from "./websocket-manager";
import type { Logger } from "../logger";
import type { ClientInfo } from "../types";
import type { SessionRepository, WsClientMappingResult } from "./repository";
import type { SandboxRow } from "./types";

// ---------------------------------------------------------------------------
// Fakes & Helpers
// ---------------------------------------------------------------------------

/** Minimal fake WebSocket for testing. */
function createFakeWebSocket(readyState = WebSocket.OPEN): WebSocket {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    url: "",
    protocol: "",
    extensions: "",
    bufferedAmount: 0,
    binaryType: "blob",
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    CONNECTING: 0,
    OPEN: 1,
    CLOSING: 2,
    CLOSED: 3,
    accept: vi.fn(),
    serialize: vi.fn(),
    deserialize: vi.fn(),
    serializeAttachment: vi.fn(),
    deserializeAttachment: vi.fn(),
  } as unknown as WebSocket;
}

/** Type for the fake DurableObjectState with test helpers. */
interface FakeCtx {
  sockets: Map<WebSocket, string[]>;
  state: DurableObjectState;
}

/**
 * Fake DurableObjectState that tracks accepted WebSockets and their tags.
 */
function createFakeCtx(): FakeCtx {
  const sockets = new Map<WebSocket, string[]>();

  const state = {
    acceptWebSocket(ws: WebSocket, tags: string[]) {
      sockets.set(ws, tags);
    },
    getTags(ws: WebSocket): string[] {
      return sockets.get(ws) ?? [];
    },
    getWebSockets(): WebSocket[] {
      return Array.from(sockets.keys());
    },
    setWebSocketAutoResponse: vi.fn(),
    storage: { setAlarm: vi.fn() },
    id: { toString: () => "test-do-id" },
    waitUntil: vi.fn(),
  } as unknown as DurableObjectState;

  return { sockets, state };
}

/** Create a minimal mock Logger. */
function createMockLogger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => createMockLogger()),
  };
}

/** Create a mock SessionRepository with configurable return values. */
function createMockRepository() {
  const mappings = new Map<string, WsClientMappingResult>();
  let sandboxRow: SandboxRow | null = null;
  const upsertCalls: Array<{
    wsId: string;
    participantId: string;
    clientId: string;
    createdAt: number;
  }> = [];

  const repo = {
    getSandbox: () => sandboxRow,
    getWsClientMapping: (wsId: string) => mappings.get(wsId) ?? null,
    hasWsClientMapping: (wsId: string) => mappings.has(wsId),
    upsertWsClientMapping: (data: {
      wsId: string;
      participantId: string;
      clientId: string;
      createdAt: number;
    }) => {
      upsertCalls.push(data);
      mappings.set(data.wsId, {
        participant_id: data.participantId,
        client_id: data.clientId,
        user_id: `user-${data.participantId}`,
        github_name: null,
        github_login: null,
      });
    },
  } as unknown as SessionRepository;

  return {
    repo,
    mappings,
    upsertCalls,
    setSandbox: (row: SandboxRow | null) => {
      sandboxRow = row;
    },
    addMapping: (wsId: string, mapping: WsClientMappingResult) => {
      mappings.set(wsId, mapping);
    },
  };
}

/** Create a minimal ClientInfo for testing. */
function createClientInfo(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    participantId: "part-1",
    userId: "user-1",
    name: "Test User",
    status: "active",
    lastSeen: Date.now(),
    clientId: "client-1",
    ws: createFakeWebSocket(),
    ...overrides,
  };
}

/** Create a SandboxRow with the given modal_sandbox_id. */
function createSandboxRow(modalSandboxId: string): SandboxRow {
  return {
    id: "sb-row",
    modal_sandbox_id: modalSandboxId,
    modal_object_id: null,
    snapshot_id: null,
    snapshot_image_id: null,
    auth_token: null,
    status: "ready",
    git_sync_status: "completed",
    last_heartbeat: null,
    last_activity: null,
    last_spawn_error: null,
    last_spawn_error_at: null,
    created_at: Date.now(),
  };
}

const TEST_CONFIG: WebSocketManagerConfig = { authTimeoutMs: 100 };

/** Create a fresh manager with all dependencies. */
function createManager() {
  const fakeCtx = createFakeCtx();
  const mockRepo = createMockRepository();
  const log = createMockLogger();

  const manager = new SessionWebSocketManagerImpl(fakeCtx.state, mockRepo.repo, log, TEST_CONFIG);

  return { manager, sockets: fakeCtx.sockets, state: fakeCtx.state, mockRepo, log };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SessionWebSocketManagerImpl", () => {
  describe("classify", () => {
    it("classifies sandbox socket with sandbox ID", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["sandbox", "sid:abc"]);

      const result = manager.classify(ws);
      expect(result).toEqual({ kind: "sandbox", sandboxId: "abc" });
    });

    it("classifies sandbox socket without sandbox ID", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["sandbox"]);

      const result = manager.classify(ws);
      expect(result).toEqual({ kind: "sandbox", sandboxId: undefined });
    });

    it("classifies client socket with wsId", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:xyz"]);

      const result = manager.classify(ws);
      expect(result).toEqual({ kind: "client", wsId: "xyz" });
    });

    it("classifies socket with no tags as client", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, []);

      const result = manager.classify(ws);
      expect(result).toEqual({ kind: "client", wsId: undefined });
    });
  });

  describe("acceptClientSocket", () => {
    it("accepts with wsid tag", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      manager.acceptClientSocket(ws, "ws-123");

      expect(sockets.get(ws)).toEqual(["wsid:ws-123"]);
    });
  });

  describe("acceptAndSetSandboxSocket", () => {
    it("accepts with sandbox + sid tags", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      const result = manager.acceptAndSetSandboxSocket(ws, "sandbox-abc");

      expect(result.replaced).toBe(false);
      const tags = sockets.get(ws)!;
      expect(tags).toContain("sandbox");
      expect(tags).toContain("sid:sandbox-abc");
    });

    it("accepts with only sandbox tag when no sandboxId", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(ws);

      expect(sockets.get(ws)).toEqual(["sandbox"]);
    });

    it("closes existing sandbox socket and returns replaced=true", () => {
      const { manager } = createManager();
      const oldWs = createFakeWebSocket();
      const newWs = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(oldWs, "sb-1");
      const result = manager.acceptAndSetSandboxSocket(newWs, "sb-2");

      expect(result.replaced).toBe(true);
      expect(oldWs.close).toHaveBeenCalledWith(1000, "New sandbox connecting");
    });

    it("does not try to close an already-closed sandbox socket", () => {
      const { manager } = createManager();
      const oldWs = createFakeWebSocket(WebSocket.CLOSED);
      const newWs = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(oldWs);
      const result = manager.acceptAndSetSandboxSocket(newWs);

      expect(result.replaced).toBe(false);
      expect(oldWs.close).not.toHaveBeenCalled();
    });

    it("sets new socket as active sandbox", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(ws, "sb-1");

      expect(manager.getSandboxSocket()).toBe(ws);
    });
  });

  describe("getSandboxSocket", () => {
    it("returns cached socket if open", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(ws, "sb-1");

      expect(manager.getSandboxSocket()).toBe(ws);
    });

    it("returns null when no sandbox socket exists", () => {
      const { manager } = createManager();
      expect(manager.getSandboxSocket()).toBeNull();
    });

    it("recovers from hibernation by scanning ctx.getWebSockets()", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();

      // Simulate hibernation: socket is in ctx but not in memory
      sockets.set(ws, ["sandbox", "sid:sb-1"]);
      mockRepo.setSandbox(createSandboxRow("sb-1"));

      expect(manager.getSandboxSocket()).toBe(ws);
    });

    it("skips sockets with wrong sandbox ID during recovery", () => {
      const { manager, sockets, mockRepo } = createManager();
      const wrongWs = createFakeWebSocket();

      sockets.set(wrongWs, ["sandbox", "sid:wrong-id"]);
      mockRepo.setSandbox(createSandboxRow("correct-id"));

      expect(manager.getSandboxSocket()).toBeNull();
    });

    it("returns null when cached socket is closed", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket(WebSocket.CLOSED);

      manager.acceptAndSetSandboxSocket(ws, "sb-1");

      expect(manager.getSandboxSocket()).toBeNull();
    });
  });

  describe("clearSandboxSocket", () => {
    it("clears the in-memory reference", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(ws, "sb-1");
      manager.clearSandboxSocket();

      // Close the socket so hibernation recovery also fails,
      // confirming the cached ref was cleared.
      Object.defineProperty(ws, "readyState", { value: WebSocket.CLOSED });
      expect(manager.getSandboxSocket()).toBeNull();
    });
  });

  describe("client registry", () => {
    it("setClient / getClient round-trips", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();
      const info = createClientInfo({ ws });

      manager.setClient(ws, info);

      expect(manager.getClient(ws)).toBe(info);
    });

    it("getClient returns null for unknown socket", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      expect(manager.getClient(ws)).toBeNull();
    });

    it("removeClient returns and removes the client", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();
      const info = createClientInfo({ ws });

      manager.setClient(ws, info);
      const removed = manager.removeClient(ws);

      expect(removed).toBe(info);
      expect(manager.getClient(ws)).toBeNull();
    });

    it("removeClient returns null for unknown socket", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      expect(manager.removeClient(ws)).toBeNull();
    });
  });

  describe("recoverClientMapping", () => {
    it("returns mapping when wsId tag and DB mapping exist", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["wsid:ws-42"]);
      const mapping: WsClientMappingResult = {
        participant_id: "part-1",
        client_id: "client-1",
        user_id: "user-1",
        github_name: "Test",
        github_login: "testuser",
      };
      mockRepo.addMapping("ws-42", mapping);

      expect(manager.recoverClientMapping(ws)).toEqual(mapping);
    });

    it("returns null for sandbox-tagged sockets", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["sandbox"]);

      expect(manager.recoverClientMapping(ws)).toBeNull();
    });

    it("returns null when no wsId tag", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, []);

      expect(manager.recoverClientMapping(ws)).toBeNull();
    });

    it("returns null when no DB mapping found", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["wsid:ws-nonexistent"]);

      expect(manager.recoverClientMapping(ws)).toBeNull();
    });
  });

  describe("persistClientMapping", () => {
    it("calls repository.upsertWsClientMapping", () => {
      const { manager, mockRepo } = createManager();

      manager.persistClientMapping("ws-1", "part-1", "client-1");

      expect(mockRepo.upsertCalls).toHaveLength(1);
      expect(mockRepo.upsertCalls[0]).toMatchObject({
        wsId: "ws-1",
        participantId: "part-1",
        clientId: "client-1",
      });
    });
  });

  describe("hasPersistedMapping", () => {
    it("returns true when mapping exists", () => {
      const { manager, mockRepo } = createManager();
      mockRepo.addMapping("ws-1", {
        participant_id: "p-1",
        client_id: "c-1",
        user_id: "u-1",
        github_name: null,
        github_login: null,
      });

      expect(manager.hasPersistedMapping("ws-1")).toBe(true);
    });

    it("returns false when no mapping", () => {
      const { manager } = createManager();
      expect(manager.hasPersistedMapping("ws-nonexistent")).toBe(false);
    });
  });

  describe("send", () => {
    it("sends JSON-stringified object when socket is open", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      const result = manager.send(ws, { type: "test" });

      expect(result).toBe(true);
      expect(ws.send).toHaveBeenCalledWith('{"type":"test"}');
    });

    it("sends raw string when given a string", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      manager.send(ws, "raw message");

      expect(ws.send).toHaveBeenCalledWith("raw message");
    });

    it("returns false when socket is not open", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket(WebSocket.CLOSED);

      expect(manager.send(ws, "test")).toBe(false);
    });

    it("returns false on send error", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();
      (ws.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Send failed");
      });

      expect(manager.send(ws, "test")).toBe(false);
    });
  });

  describe("close", () => {
    it("closes the socket with given code and reason", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      manager.close(ws, 4008, "Auth timeout");

      expect(ws.close).toHaveBeenCalledWith(4008, "Auth timeout");
    });

    it("swallows errors from already-closed sockets", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();
      (ws.close as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("Already closed");
      });

      // Should not throw
      expect(() => manager.close(ws, 1000, "test")).not.toThrow();
    });
  });

  describe("forEachClientSocket", () => {
    it("all_clients mode calls fn for all non-sandbox sockets", () => {
      const { manager, sockets } = createManager();
      const clientWs1 = createFakeWebSocket();
      const clientWs2 = createFakeWebSocket();
      const sandboxWs = createFakeWebSocket();

      sockets.set(clientWs1, ["wsid:ws-1"]);
      sockets.set(clientWs2, ["wsid:ws-2"]);
      sockets.set(sandboxWs, ["sandbox"]);

      const called: WebSocket[] = [];
      manager.forEachClientSocket("all_clients", (ws) => called.push(ws));

      expect(called).toHaveLength(2);
      expect(called).toContain(clientWs1);
      expect(called).toContain(clientWs2);
      expect(called).not.toContain(sandboxWs);
    });

    it("authenticated_only mode calls fn for in-memory authenticated sockets", () => {
      const { manager, sockets } = createManager();
      const authedWs = createFakeWebSocket();
      const unauthedWs = createFakeWebSocket();

      sockets.set(authedWs, ["wsid:ws-1"]);
      sockets.set(unauthedWs, ["wsid:ws-2"]);

      manager.setClient(authedWs, createClientInfo({ ws: authedWs }));

      const called: WebSocket[] = [];
      manager.forEachClientSocket("authenticated_only", (ws) => called.push(ws));

      expect(called).toEqual([authedWs]);
    });

    it("authenticated_only mode calls fn for sockets with persisted DB mapping", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["wsid:ws-recovered"]);

      // Simulate post-hibernation: no in-memory client, but DB mapping exists
      mockRepo.addMapping("ws-recovered", {
        participant_id: "p-1",
        client_id: "c-1",
        user_id: "u-1",
        github_name: null,
        github_login: null,
      });

      const called: WebSocket[] = [];
      manager.forEachClientSocket("authenticated_only", (ws) => called.push(ws));

      expect(called).toEqual([ws]);
    });

    it("authenticated_only mode skips sockets with no auth evidence", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["wsid:ws-unknown"]);

      const called: WebSocket[] = [];
      manager.forEachClientSocket("authenticated_only", (ws) => called.push(ws));

      expect(called).toHaveLength(0);
    });

    it("broadcast pattern delivers to authenticated clients and skips unauthenticated", () => {
      const { manager, sockets, mockRepo } = createManager();

      // Authenticated client (in-memory)
      const authedWs = createFakeWebSocket();
      sockets.set(authedWs, ["wsid:ws-authed"]);
      manager.setClient(authedWs, createClientInfo({ ws: authedWs }));

      // Post-hibernation client (persisted mapping only, no in-memory ClientInfo)
      const hibernatedWs = createFakeWebSocket();
      sockets.set(hibernatedWs, ["wsid:ws-hibernated"]);
      mockRepo.addMapping("ws-hibernated", {
        participant_id: "p-2",
        client_id: "c-2",
        user_id: "u-2",
        github_name: null,
        github_login: null,
      });

      // Unauthenticated client (connected but never subscribed)
      const unauthWs = createFakeWebSocket();
      sockets.set(unauthWs, ["wsid:ws-unauth"]);

      // Sandbox (should never receive)
      const sandboxWs = createFakeWebSocket();
      sockets.set(sandboxWs, ["sandbox", "sid:sb-1"]);

      // Simulate the DO's broadcast() pattern
      const message = JSON.stringify({ type: "sandbox_status", status: "ready" });
      manager.forEachClientSocket("authenticated_only", (ws) => {
        manager.send(ws, message);
      });

      expect(authedWs.send).toHaveBeenCalledWith(message);
      expect(hibernatedWs.send).toHaveBeenCalledWith(message);
      expect(unauthWs.send).not.toHaveBeenCalled();
      expect(sandboxWs.send).not.toHaveBeenCalled();
    });

    it("never calls fn for sandbox sockets regardless of mode", () => {
      const { manager, sockets } = createManager();
      const sandboxWs = createFakeWebSocket();

      sockets.set(sandboxWs, ["sandbox"]);

      const allClientsCalled: WebSocket[] = [];
      manager.forEachClientSocket("all_clients", (ws) => allClientsCalled.push(ws));
      expect(allClientsCalled).toHaveLength(0);

      const authOnlyCalled: WebSocket[] = [];
      manager.forEachClientSocket("authenticated_only", (ws) => authOnlyCalled.push(ws));
      expect(authOnlyCalled).toHaveLength(0);
    });
  });

  describe("enforceAuthTimeout", () => {
    it("does not close socket if authenticated in-memory before timeout", async () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-1"]);

      manager.setClient(ws, createClientInfo({ ws }));

      await manager.enforceAuthTimeout(ws, "ws-1");

      expect(ws.close).not.toHaveBeenCalled();
    });

    it("does not close socket if DB mapping exists after hibernation", async () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-1"]);

      mockRepo.addMapping("ws-1", {
        participant_id: "p-1",
        client_id: "c-1",
        user_id: "u-1",
        github_name: null,
        github_login: null,
      });

      await manager.enforceAuthTimeout(ws, "ws-1");

      expect(ws.close).not.toHaveBeenCalled();
    });

    it("closes socket with 4008 if neither in-memory nor DB mapping", async () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-1"]);

      await manager.enforceAuthTimeout(ws, "ws-1");

      expect(ws.close).toHaveBeenCalledWith(4008, "Authentication timeout");
    });

    it("does nothing if socket is already closed", async () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket(WebSocket.CLOSED);

      await manager.enforceAuthTimeout(ws, "ws-1");

      expect(ws.close).not.toHaveBeenCalled();
    });
  });

  describe("getAuthenticatedClients", () => {
    it("iterates over all registered clients", () => {
      const { manager } = createManager();
      const ws1 = createFakeWebSocket();
      const ws2 = createFakeWebSocket();
      const info1 = createClientInfo({ ws: ws1, userId: "user-1" });
      const info2 = createClientInfo({ ws: ws2, userId: "user-2" });

      manager.setClient(ws1, info1);
      manager.setClient(ws2, info2);

      const clients = Array.from(manager.getAuthenticatedClients());
      expect(clients).toHaveLength(2);
      expect(clients).toContain(info1);
      expect(clients).toContain(info2);
    });

    it("returns empty iterator when no clients", () => {
      const { manager } = createManager();
      const clients = Array.from(manager.getAuthenticatedClients());
      expect(clients).toHaveLength(0);
    });
  });

  describe("getConnectedClientCount", () => {
    it("counts only non-sandbox open sockets", () => {
      const { manager, sockets } = createManager();
      const clientWs1 = createFakeWebSocket();
      const clientWs2 = createFakeWebSocket(WebSocket.CLOSED);
      const sandboxWs = createFakeWebSocket();

      sockets.set(clientWs1, ["wsid:ws-1"]);
      sockets.set(clientWs2, ["wsid:ws-2"]);
      sockets.set(sandboxWs, ["sandbox"]);

      expect(manager.getConnectedClientCount()).toBe(1);
    });

    it("returns 0 when no sockets", () => {
      const { manager } = createManager();
      expect(manager.getConnectedClientCount()).toBe(0);
    });
  });
});
