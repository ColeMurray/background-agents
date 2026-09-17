/**
 * Unit tests for SessionWebSocketManagerImpl.
 *
 * Uses a fake SessionWebSocketHost and mock repositories to test
 * all WebSocket mechanics in isolation from the host.
 */

import { describe, it, expect, vi } from "vitest";
import { SessionWebSocketManagerImpl } from "./websocket-manager";
import type { WebSocketManagerConfig } from "./websocket-manager";
import type { Logger } from "../logger";
import type { SessionWebSocket } from "../platform-ports";
import type { SessionWebSocketHost } from "./platform";
import type { ClientInfo } from "../types";
import type { SandboxRepository } from "./sandbox-repository";
import type {
  WsClientMappingRepository,
  WsClientMappingResult,
} from "./ws-client-mapping-repository";
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
interface FakeSocketHost {
  sockets: Map<SessionWebSocket, string[]>;
  host: SessionWebSocketHost;
}

/**
 * Fake SessionWebSocketHost that tracks accepted WebSockets and their tags.
 */
function createFakeSocketHost(): FakeSocketHost {
  const sockets = new Map<SessionWebSocket, string[]>();

  const host: SessionWebSocketHost = {
    adopt(ws, tags) {
      sockets.set(ws, tags);
    },
    tags(ws) {
      return sockets.get(ws) ?? [];
    },
    sockets(tag) {
      const accepted = Array.from(sockets.keys());
      return tag === undefined
        ? accepted
        : accepted.filter((ws) => (sockets.get(ws) ?? []).includes(tag));
    },
    setAutoResponse: vi.fn(),
  };

  return { sockets, host };
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

/** Create mock repositories with configurable return values. */
function createMockRepository() {
  const mappings = new Map<string, WsClientMappingResult>();
  let sandboxRow: SandboxRow | null = null;
  const upsertCalls: Array<{
    wsId: string;
    participantId: string;
    clientId: string;
    createdAt: number;
    authorizationExpiresAt: number;
  }> = [];

  const repo = {
    getSandbox: () => sandboxRow,
    setActiveSocketId: (socketId: string) => {
      // Like the UPDATE it stands in for: nothing to write without a row.
      if (sandboxRow) sandboxRow.active_socket_id = socketId;
    },
    revokeActiveSocketId: () => {
      if (sandboxRow) sandboxRow.active_socket_id = "";
    },
    getWsClientMapping: (wsId: string) => mappings.get(wsId) ?? null,
    hasWsClientMapping: (wsId: string) => mappings.has(wsId),
    upsertWsClientMapping: (data: {
      wsId: string;
      participantId: string;
      clientId: string;
      createdAt: number;
      authorizationExpiresAt: number;
    }) => {
      upsertCalls.push(data);
      mappings.set(data.wsId, {
        participant_id: data.participantId,
        client_id: data.clientId,
        user_id: `user-${data.participantId}`,
        scm_name: null,
        auth_name: null,
        scm_login: null,
        authorization_expires_at: data.authorizationExpiresAt,
      });
    },
    deleteWsClientMapping: (wsId: string) => mappings.delete(wsId),
    deleteExpiredMappings: (now: number) => {
      for (const [wsId, mapping] of mappings) {
        if (mapping.authorization_expires_at <= now) mappings.delete(wsId);
      }
    },
    getNextAuthorizationExpiry: () => {
      const expiries = Array.from(mappings.values()).map(
        (mapping) => mapping.authorization_expires_at
      );
      return expiries.length > 0 ? Math.min(...expiries) : null;
    },
  } as unknown as SandboxRepository;

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
    authorizationExpiresAt: Date.now() + 300_000,
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
    snapshot_runtime_version: null,
    runtime_version: null,
    auth_token: null,
    auth_token_hash: null,
    status: "ready",
    git_sync_status: "completed",
    last_heartbeat: null,
    last_activity: null,
    last_spawn_error: null,
    last_spawn_error_at: null,
    code_server_url: null,
    code_server_password: null,
    vnc_url: null,
    vnc_password: null,
    tunnel_urls: null,
    ttyd_url: null,
    ttyd_token: null,
    active_socket_id: null,
    created_at: Date.now(),
  };
}

const TEST_CONFIG: WebSocketManagerConfig = { authTimeoutMs: 100 };

/** Create a fresh manager with all dependencies. */
function createManager() {
  const fakeHost = createFakeSocketHost();
  const mockRepo = createMockRepository();
  const alarmScheduler = {
    schedule: vi.fn(async () => {}),
    cancel: vi.fn(async () => {}),
    current: vi.fn(async () => null),
  };
  const log = createMockLogger();

  const manager = new SessionWebSocketManagerImpl(
    fakeHost.host,
    mockRepo.repo,
    mockRepo.repo as unknown as WsClientMappingRepository,
    alarmScheduler,
    log,
    TEST_CONFIG
  );

  return {
    manager,
    sockets: fakeHost.sockets,
    host: fakeHost.host,
    mockRepo,
    alarmScheduler,
    log,
  };
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

      expect(sockets.get(ws)).toEqual(["sandbox", expect.stringMatching(/^socket:sbws-/)]);
    });

    it("persists the new socket's identity before closing the socket it replaces", () => {
      const { manager, mockRepo } = createManager();
      const row = createSandboxRow("sb-1");
      mockRepo.setSandbox(row);
      const order: string[] = [];
      const oldWs = createFakeWebSocket();
      vi.mocked(oldWs.close).mockImplementation(() => {
        order.push(`close:${row.active_socket_id}`);
      });
      const newWs = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(oldWs, "sb-1");
      const oldId = row.active_socket_id;
      manager.acceptAndSetSandboxSocket(newWs, "sb-1");
      const newId = row.active_socket_id;

      expect(oldId).toMatch(/^sbws-/);
      expect(newId).toMatch(/^sbws-/);
      expect(newId).not.toBe(oldId);
      // The row already named the replacement when the old socket was closed.
      expect(order).toEqual([`close:${newId}`]);
      expect(manager.classify(newWs)).toEqual({
        kind: "sandbox",
        sandboxId: "sb-1",
        socketId: newId,
      });
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

    it("closes an attached sandbox socket after the in-memory pointer is lost", () => {
      const { manager } = createManager();
      const oldWs = createFakeWebSocket();
      const newWs = createFakeWebSocket();
      manager.acceptAndSetSandboxSocket(oldWs, "sb-1");
      manager.clearSandboxSocket();

      const result = manager.acceptAndSetSandboxSocket(newWs, "sb-1");

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
      const { manager, mockRepo } = createManager();
      mockRepo.setSandbox(createSandboxRow("sb-1"));
      const ws = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(ws, "sb-1");

      expect(manager.getSandboxSocket()).toBe(ws);
    });
  });

  describe("isActiveSandboxSocket", () => {
    it("is true only for the most recently accepted sandbox socket", () => {
      const { manager, mockRepo } = createManager();
      mockRepo.setSandbox(createSandboxRow("sb-1"));
      const oldWs = createFakeWebSocket();
      const newWs = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(oldWs, "sb-1");
      expect(manager.isActiveSandboxSocket(oldWs)).toBe(true);

      // Same sandbox reconnecting: the replaced socket is still OPEN while
      // its close completes, and still tagged, but no longer authoritative.
      manager.acceptAndSetSandboxSocket(newWs, "sb-1");
      expect(manager.isActiveSandboxSocket(oldWs)).toBe(false);
      expect(manager.isActiveSandboxSocket(newWs)).toBe(true);
    });

    it("is false for client sockets", () => {
      const { manager, mockRepo } = createManager();
      mockRepo.setSandbox(createSandboxRow("sb-1"));
      const ws = createFakeWebSocket();
      manager.acceptClientSocket(ws, "ws-1");

      expect(manager.isActiveSandboxSocket(ws)).toBe(false);
    });

    it("is false once a spawn reservation has revoked the persisted identity", () => {
      const { manager, mockRepo } = createManager();
      const row = createSandboxRow("sb-1");
      mockRepo.setSandbox(row);
      const ws = createFakeWebSocket();
      manager.acceptAndSetSandboxSocket(ws, "sb-1");

      // What updateSandboxForSpawn writes.
      row.active_socket_id = "";
      row.modal_sandbox_id = "sb-2";

      expect(manager.isActiveSandboxSocket(ws)).toBe(false);
    });

    it("is false for every socket once detach has revoked authority", () => {
      const { manager, sockets, mockRepo } = createManager();
      const row = createSandboxRow("sb-1");
      mockRepo.setSandbox(row);
      const ws = createFakeWebSocket();
      manager.acceptAndSetSandboxSocket(ws, "sb-1");

      manager.detachSandboxSocket(1000, "Heartbeat stale");

      expect(row.active_socket_id).toBe("");
      expect(ws.close).toHaveBeenCalledWith(1000, "Heartbeat stale");
      // The close is cleanup; the row is the fence, so a trailing frame from
      // the still-tagged socket is refused whether or not the close landed.
      expect(manager.isActiveSandboxSocket(ws)).toBe(false);
      expect(manager.clearSandboxSocketIfMatch(ws)).toBe(false);
      // Nor does a restart re-adopt it, even after an in-place resume.
      row.status = "connecting";
      expect(sockets.get(ws)).toBeDefined();
      expect(manager.getSandboxSocket()).toBeNull();
    });

    it("revokes authority before closing on detach", () => {
      const { manager, mockRepo } = createManager();
      const row = createSandboxRow("sb-1");
      mockRepo.setSandbox(row);
      const ws = createFakeWebSocket();
      vi.mocked(ws.close).mockImplementation(() => {
        expect(row.active_socket_id).toBe("");
      });
      manager.acceptAndSetSandboxSocket(ws, "sb-1");

      manager.detachSandboxSocket(1011, "Fatal sandbox runtime error");

      expect(ws.close).toHaveBeenCalledOnce();
    });

    it("keeps a socket accepted before identities were persisted authoritative", () => {
      const { manager, sockets, mockRepo } = createManager();
      mockRepo.setSandbox(createSandboxRow("sb-1"));
      const legacyWs = createFakeWebSocket();
      sockets.set(legacyWs, ["sandbox", "sid:sb-1"]);

      expect(manager.isActiveSandboxSocket(legacyWs)).toBe(true);

      const newWs = createFakeWebSocket();
      manager.acceptAndSetSandboxSocket(newWs, "sb-1");
      expect(manager.isActiveSandboxSocket(legacyWs)).toBe(false);
    });

    it("requires a pre-identity socket to belong to the row's sandbox", () => {
      const { manager, sockets, mockRepo } = createManager();
      mockRepo.setSandbox(createSandboxRow("sb-2"));
      const staleWs = createFakeWebSocket();
      sockets.set(staleWs, ["sandbox", "sid:sb-1"]);

      expect(manager.isActiveSandboxSocket(staleWs)).toBe(false);
    });

    it("refuses a pre-identity socket once a spawn reservation has revoked authority", () => {
      const { manager, sockets, mockRepo } = createManager();
      const row = createSandboxRow("sb-1");
      mockRepo.setSandbox(row);
      const legacyWs = createFakeWebSocket();
      sockets.set(legacyWs, ["sandbox", "sid:sb-1"]);
      expect(manager.isActiveSandboxSocket(legacyWs)).toBe(true);

      // The reservation revokes rather than clears, so the migration
      // compatibility branch never reopens for a displaced sandbox.
      row.active_socket_id = "";
      row.modal_sandbox_id = "sb-2";

      expect(manager.isActiveSandboxSocket(legacyWs)).toBe(false);
      expect(manager.clearSandboxSocketIfMatch(legacyWs)).toBe(false);
      expect(manager.getSandboxSocket()).toBeNull();
      expect(legacyWs.close).toHaveBeenCalledWith(1000, "Sandbox identity changed");
    });
  });

  describe("getSandboxSocket", () => {
    it("returns cached socket if open", () => {
      const { manager, mockRepo } = createManager();
      mockRepo.setSandbox(createSandboxRow("sb-1"));
      const ws = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(ws, "sb-1");

      expect(manager.getSandboxSocket()).toBe(ws);
    });

    it("recovers the socket whose identity the row names, not the first open one", () => {
      const { manager, sockets, mockRepo } = createManager();
      const row = createSandboxRow("sb-1");
      row.active_socket_id = "sbws-active";
      mockRepo.setSandbox(row);
      const replacedWs = createFakeWebSocket();
      const activeWs = createFakeWebSocket();

      // Both sockets belong to the same sandbox and both still look OPEN
      // after a restart; the replaced one is enumerated first.
      sockets.set(replacedWs, ["sandbox", "sid:sb-1", "socket:sbws-replaced"]);
      sockets.set(activeWs, ["sandbox", "sid:sb-1", "socket:sbws-active"]);

      expect(manager.getSandboxSocket()).toBe(activeWs);
      expect(replacedWs.close).not.toHaveBeenCalled();
    });

    it("returns null when only replaced sockets survive a restart", () => {
      const { manager, sockets, mockRepo } = createManager();
      const row = createSandboxRow("sb-1");
      row.active_socket_id = "sbws-active";
      mockRepo.setSandbox(row);
      const replacedWs = createFakeWebSocket();
      sockets.set(replacedWs, ["sandbox", "sid:sb-1", "socket:sbws-replaced"]);

      expect(manager.getSandboxSocket()).toBeNull();
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
      expect(wrongWs.close).toHaveBeenCalledWith(1000, "Sandbox identity changed");
    });

    it("skips sockets without the expected sandbox ID tag during recovery", () => {
      const { manager, sockets, mockRepo } = createManager();
      const untaggedWs = createFakeWebSocket();

      sockets.set(untaggedWs, ["sandbox"]);
      mockRepo.setSandbox(createSandboxRow("correct-id"));

      expect(manager.getSandboxSocket()).toBeNull();
      expect(untaggedWs.close).toHaveBeenCalledWith(1000, "Sandbox identity changed");
    });

    it("rejects a cached socket when the persisted sandbox ID changes", () => {
      const { manager, mockRepo } = createManager();
      const oldWs = createFakeWebSocket();
      manager.acceptAndSetSandboxSocket(oldWs, "old-id");
      mockRepo.setSandbox(createSandboxRow("new-id"));

      expect(manager.getSandboxSocket()).toBeNull();
      expect(oldWs.close).toHaveBeenCalledWith(1000, "Sandbox identity changed");
    });

    it("returns null when cached socket is closed", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket(WebSocket.CLOSED);

      manager.acceptAndSetSandboxSocket(ws, "sb-1");

      expect(manager.getSandboxSocket()).toBeNull();
    });

    it("returns null and closes zombie WS when sandbox status is stopped", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();

      // Simulate: sandbox was stopped (inactivity timeout) but WS close handshake
      // didn't complete before hibernation, so the WS still appears OPEN.
      sockets.set(ws, ["sandbox", "sid:sb-1"]);
      const row = createSandboxRow("sb-1");
      row.status = "stopped";
      mockRepo.setSandbox(row);

      expect(manager.getSandboxSocket()).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1000, "Sandbox terminated");
    });

    it("checks persisted terminal status before returning a cached open socket", () => {
      const { manager, mockRepo } = createManager();
      const ws = createFakeWebSocket();
      manager.acceptAndSetSandboxSocket(ws, "sb-1");
      const row = createSandboxRow("sb-1");
      row.status = "stale";
      mockRepo.setSandbox(row);

      expect(manager.getSandboxSocket()).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1000, "Sandbox terminated");
    });

    it("returns null and closes zombie WS when sandbox status is stale", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["sandbox", "sid:sb-1"]);
      const row = createSandboxRow("sb-1");
      row.status = "stale";
      mockRepo.setSandbox(row);

      expect(manager.getSandboxSocket()).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1000, "Sandbox terminated");
    });

    it("returns null and closes zombie WS when sandbox status is failed", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["sandbox", "sid:sb-1"]);
      const row = createSandboxRow("sb-1");
      row.status = "failed";
      mockRepo.setSandbox(row);

      expect(manager.getSandboxSocket()).toBeNull();
      expect(ws.close).toHaveBeenCalledWith(1000, "Sandbox terminated");
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

  describe("detachSandboxSocket", () => {
    it("clears and closes the cached sandbox socket even after status becomes terminal", () => {
      const { manager, mockRepo } = createManager();
      const ws = createFakeWebSocket();
      manager.acceptAndSetSandboxSocket(ws, "sb-1");
      const row = createSandboxRow("sb-1");
      row.status = "stale";
      mockRepo.setSandbox(row);

      manager.detachSandboxSocket(1011, "Stop confirmation timed out");

      expect(ws.close).toHaveBeenCalledWith(1011, "Stop confirmation timed out");
      expect(manager.getSandboxSocket()).toBeNull();
    });
  });

  describe("clearSandboxSocketIfMatch", () => {
    it("clears and returns true when ws matches", () => {
      const { manager, mockRepo } = createManager();
      mockRepo.setSandbox(createSandboxRow("sb-1"));
      const ws = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(ws, "sb-1");
      const result = manager.clearSandboxSocketIfMatch(ws);

      expect(result).toBe(true);
      // Verify it was actually cleared
      Object.defineProperty(ws, "readyState", { value: WebSocket.CLOSED });
      expect(manager.getSandboxSocket()).toBeNull();
    });

    it("returns false and does not clear when ws does not match", () => {
      const { manager, mockRepo } = createManager();
      mockRepo.setSandbox(createSandboxRow("sb-1"));
      const oldWs = createFakeWebSocket();
      const newWs = createFakeWebSocket();

      manager.acceptAndSetSandboxSocket(oldWs, "sb-1");
      manager.acceptAndSetSandboxSocket(newWs, "sb-1");

      // Try to clear with old socket — should not affect new socket
      const result = manager.clearSandboxSocketIfMatch(oldWs);

      expect(result).toBe(false);
      expect(manager.getSandboxSocket()).toBe(newWs);
    });

    it("recognizes the active socket after a restart by its persisted identity", () => {
      const { manager, sockets, mockRepo } = createManager();
      const row = createSandboxRow("sb-1");
      row.active_socket_id = "sbws-active";
      mockRepo.setSandbox(row);
      const activeWs = createFakeWebSocket();
      const replacedWs = createFakeWebSocket();
      sockets.set(activeWs, ["sandbox", "sid:sb-1", "socket:sbws-active"]);
      sockets.set(replacedWs, ["sandbox", "sid:sb-1", "socket:sbws-replaced"]);

      expect(manager.clearSandboxSocketIfMatch(replacedWs)).toBe(false);
      expect(manager.clearSandboxSocketIfMatch(activeWs)).toBe(true);
    });

    it("treats the close of a socket a spawn reservation displaced as a replacement", () => {
      const { manager, mockRepo } = createManager();
      const row = createSandboxRow("sb-1");
      mockRepo.setSandbox(row);
      const ws = createFakeWebSocket();
      manager.acceptAndSetSandboxSocket(ws, "sb-1");
      row.active_socket_id = "";
      row.modal_sandbox_id = "sb-2";

      expect(manager.clearSandboxSocketIfMatch(ws)).toBe(false);
      // The pointer is still dropped: nothing may keep sending into it.
      Object.defineProperty(ws, "readyState", { value: WebSocket.CLOSED });
      expect(manager.getSandboxSocket()).toBeNull();
    });
  });

  describe("client registry", () => {
    it("returns a cached live client", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();
      const info = createClientInfo();

      manager.setClient(ws, info);

      expect(manager.lookupClient(ws)).toEqual({ kind: "cached", client: info });
    });

    it("returns missing for an unknown socket", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      expect(manager.lookupClient(ws)).toEqual({ kind: "missing" });
    });

    it("rejects an expired live client on inbound lookup", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-expired"]);
      manager.setClient(ws, createClientInfo({ authorizationExpiresAt: Date.now() - 1 }));

      expect(manager.lookupClient(ws)).toEqual({ kind: "authorization_rejected" });
      expect(ws.close).toHaveBeenCalledWith(4010, "Authorization expired or changed");
    });

    it("removeClient returns the client and removes every identity representation", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();
      const info = createClientInfo();
      sockets.set(ws, ["wsid:ws-1"]);
      mockRepo.addMapping("ws-1", {
        participant_id: info.participantId,
        client_id: info.clientId,
        user_id: info.userId,
        scm_name: null,
        scm_login: null,
        authorization_expires_at: info.authorizationExpiresAt,
      });

      manager.setClient(ws, info);
      manager.setClientSynchronizing(ws, true);
      const removed = manager.removeClient(ws);

      expect(removed).toBe(info);
      expect(manager.lookupClient(ws)).toEqual({ kind: "missing" });
      expect(manager.isClientSynchronizing(ws)).toBe(false);
      expect(mockRepo.mappings.has("ws-1")).toBe(false);
    });

    it("removeClient returns null for unknown socket", () => {
      const { manager } = createManager();
      const ws = createFakeWebSocket();

      expect(manager.removeClient(ws)).toBeNull();
    });
  });

  describe("lookupClient", () => {
    it("returns mapping when wsId tag and DB mapping exist", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["wsid:ws-42"]);
      const mapping: WsClientMappingResult = {
        participant_id: "part-1",
        client_id: "client-1",
        user_id: "user-1",
        scm_name: "Test",
        auth_name: null,
        scm_login: "testuser",
        authorization_expires_at: Date.now() + 300_000,
      };
      mockRepo.addMapping("ws-42", mapping);

      expect(manager.lookupClient(ws)).toEqual({ kind: "recovered", mapping });
    });

    it("returns null for sandbox-tagged sockets", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["sandbox"]);

      expect(manager.lookupClient(ws)).toEqual({ kind: "missing" });
    });

    it("returns null when no wsId tag", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, []);

      expect(manager.lookupClient(ws)).toEqual({ kind: "missing" });
    });

    it("returns null when no DB mapping found", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["wsid:ws-nonexistent"]);

      expect(manager.lookupClient(ws)).toEqual({ kind: "missing" });
    });

    it("rejects an expired mapping during hibernation recovery", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-expired"]);
      mockRepo.addMapping("ws-expired", {
        participant_id: "p-1",
        client_id: "c-1",
        user_id: "u-1",
        scm_name: null,
        scm_login: null,
        authorization_expires_at: Date.now() - 1,
      });

      expect(manager.lookupClient(ws)).toEqual({ kind: "authorization_rejected" });
      expect(ws.close).toHaveBeenCalledWith(4010, "Authorization expired or changed");
    });

    it("rejects an expired in-memory lease without attempting recovery", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-expired"]);
      manager.setClient(ws, createClientInfo({ authorizationExpiresAt: Date.now() - 1 }));

      expect(manager.lookupClient(ws)).toEqual({ kind: "authorization_rejected" });
      expect(ws.close).toHaveBeenCalledTimes(1);
    });
  });

  describe("activateClient", () => {
    it("schedules then publishes one authorization lease", async () => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
      const { manager, alarmScheduler, mockRepo, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-1"]);
      const info = createClientInfo({ authorizationExpiresAt: 301_000 });

      const synchronize = vi.fn(() => true);
      await expect(manager.activateClient(ws, info, synchronize)).resolves.toBe(true);
      expect(alarmScheduler.schedule).toHaveBeenCalledWith(301_000);
      expect(synchronize).toHaveBeenCalledOnce();
      expect(mockRepo.upsertCalls).toHaveLength(1);
      expect(mockRepo.upsertCalls[0]).toMatchObject({
        wsId: "ws-1",
        participantId: "part-1",
        clientId: "client-1",
        authorizationExpiresAt: 301_000,
      });
      expect(manager.lookupClient(ws)).toEqual({ kind: "cached", client: info });
      now.mockRestore();
    });

    it("does not publish client state when scheduling fails", async () => {
      const { manager, alarmScheduler, mockRepo, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-1"]);
      alarmScheduler.schedule.mockRejectedValueOnce(new Error("alarm unavailable"));

      const synchronize = vi.fn(() => true);
      await expect(manager.activateClient(ws, createClientInfo(), synchronize)).rejects.toThrow(
        "alarm unavailable"
      );
      expect(synchronize).not.toHaveBeenCalled();
      expect(mockRepo.upsertCalls).toHaveLength(0);
      expect(manager.lookupClient(ws)).toEqual({ kind: "missing" });
    });

    it("does not publish client state when snapshot synchronization fails", async () => {
      const { manager, mockRepo, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-1"]);

      await expect(manager.activateClient(ws, createClientInfo(), () => false)).resolves.toBe(
        false
      );
      expect(mockRepo.upsertCalls).toHaveLength(0);
      expect(manager.lookupClient(ws)).toEqual({ kind: "missing" });
    });
  });

  describe("hasPersistedMapping", () => {
    it("returns true when mapping exists", () => {
      const { manager, mockRepo } = createManager();
      mockRepo.addMapping("ws-1", {
        participant_id: "p-1",
        client_id: "c-1",
        user_id: "u-1",
        scm_name: null,
        auth_name: null,
        scm_login: null,
        authorization_expires_at: Date.now() + 300_000,
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

      const called: SessionWebSocket[] = [];
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

      manager.setClient(authedWs, createClientInfo());

      const called: SessionWebSocket[] = [];
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
        scm_name: null,
        auth_name: null,
        scm_login: null,
        authorization_expires_at: Date.now() + 300_000,
      });

      const called: SessionWebSocket[] = [];
      manager.forEachClientSocket("authenticated_only", (ws) => called.push(ws));

      expect(called).toEqual([ws]);
    });

    it("authenticated_only mode skips sockets with no auth evidence", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();

      sockets.set(ws, ["wsid:ws-unknown"]);

      const called: SessionWebSocket[] = [];
      manager.forEachClientSocket("authenticated_only", (ws) => called.push(ws));

      expect(called).toHaveLength(0);
    });

    it("rejects an expired live client instead of broadcasting", () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-expired"]);
      manager.setClient(ws, createClientInfo({ authorizationExpiresAt: Date.now() - 1 }));

      const called: SessionWebSocket[] = [];
      manager.forEachClientSocket("authenticated_only", (client) => called.push(client));

      expect(called).toEqual([]);
      expect(ws.close).toHaveBeenCalledWith(4010, "Authorization expired or changed");
    });

    it("rejects an expired hibernated mapping instead of broadcasting", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-expired"]);
      mockRepo.addMapping("ws-expired", {
        participant_id: "p-1",
        client_id: "c-1",
        user_id: "u-1",
        scm_name: null,
        scm_login: null,
        authorization_expires_at: Date.now() - 1,
      });

      const called: SessionWebSocket[] = [];
      manager.forEachClientSocket("authenticated_only", (client) => called.push(client));

      expect(called).toEqual([]);
      expect(ws.close).toHaveBeenCalledWith(4010, "Authorization expired or changed");
    });

    it("broadcast pattern delivers to authenticated clients and skips unauthenticated", () => {
      const { manager, sockets, mockRepo } = createManager();

      // Authenticated client (in-memory)
      const authedWs = createFakeWebSocket();
      sockets.set(authedWs, ["wsid:ws-authed"]);
      manager.setClient(authedWs, createClientInfo());

      // Post-hibernation client (persisted mapping only, no in-memory ClientInfo)
      const hibernatedWs = createFakeWebSocket();
      sockets.set(hibernatedWs, ["wsid:ws-hibernated"]);
      mockRepo.addMapping("ws-hibernated", {
        participant_id: "p-2",
        client_id: "c-2",
        user_id: "u-2",
        scm_name: null,
        auth_name: null,
        scm_login: null,
        authorization_expires_at: Date.now() + 300_000,
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

      const allClientsCalled: SessionWebSocket[] = [];
      manager.forEachClientSocket("all_clients", (ws) => allClientsCalled.push(ws));
      expect(allClientsCalled).toHaveLength(0);

      const authOnlyCalled: SessionWebSocket[] = [];
      manager.forEachClientSocket("authenticated_only", (ws) => authOnlyCalled.push(ws));
      expect(authOnlyCalled).toHaveLength(0);
    });
  });

  describe("expireAuthorizationLeases", () => {
    it("closes expired live mappings and schedules the next deadline", async () => {
      const { manager, sockets, mockRepo, alarmScheduler } = createManager();
      const expired = createFakeWebSocket();
      sockets.set(expired, ["wsid:expired"]);
      mockRepo.addMapping("expired", {
        participant_id: "p-1",
        client_id: "c-1",
        user_id: "u-1",
        scm_name: null,
        scm_login: null,
        authorization_expires_at: 1_000,
      });
      mockRepo.addMapping("future", {
        participant_id: "p-2",
        client_id: "c-2",
        user_id: "u-2",
        scm_name: null,
        scm_login: null,
        authorization_expires_at: 3_000,
      });

      await manager.expireAuthorizationLeases(2_000);
      expect(expired.close).toHaveBeenCalledWith(4010, "Authorization expired or changed");
      expect(alarmScheduler.schedule).toHaveBeenCalledWith(3_000);
    });
  });

  describe("enforceAuthTimeout", () => {
    it("does not close socket if authenticated in-memory before timeout", async () => {
      const { manager, sockets } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-1"]);

      manager.setClient(ws, createClientInfo());

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
        scm_name: null,
        auth_name: null,
        scm_login: null,
        authorization_expires_at: Date.now() + 300_000,
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
      const info1 = createClientInfo({ userId: "user-1" });
      const info2 = createClientInfo({ userId: "user-2" });

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

    it("tears down expired clients before projecting presence", () => {
      const { manager, sockets, mockRepo } = createManager();
      const ws = createFakeWebSocket();
      sockets.set(ws, ["wsid:ws-expired"]);
      manager.setClient(ws, createClientInfo({ authorizationExpiresAt: Date.now() - 1 }));
      mockRepo.addMapping("ws-expired", {
        participant_id: "part-1",
        client_id: "client-1",
        user_id: "user-1",
        scm_name: null,
        scm_login: null,
        authorization_expires_at: Date.now() - 1,
      });

      expect(Array.from(manager.getAuthenticatedClients())).toEqual([]);
      expect(mockRepo.mappings.has("ws-expired")).toBe(false);
      expect(ws.close).toHaveBeenCalledWith(4010, "Authorization expired or changed");
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
