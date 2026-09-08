/**
 * SessionWebSocketManager — the session's socket registry over its
 * `SessionWebSocketHost`.
 *
 * The manager owns socket identity, persistence, and authorization leases.
 * The connection authenticator builds ClientInfo and stores it here after
 * snapshot synchronization.
 *
 * Exactly one sandbox socket is authoritative at a time. Accepting a bridge
 * tags its socket with a fresh `socket:<id>` and persists that id on the
 * sandbox row before the socket is published; dispatch, recovery after a
 * restart, and close handling all compare a socket's tag against the row.
 * Closing a replaced socket is cleanup — the persisted identity is the fence.
 */

import type { Logger } from "../logger";
import { isSocketOpen, type AlarmScheduler, type SessionWebSocket } from "../platform-ports";
import type { ClientInfo } from "../types";
import type { SessionWebSocketHost } from "./platform";
import type { ConnectionClassification } from "./ports";
import type { SandboxRepository } from "./sandbox-repository";
import type { SandboxRow } from "./types";
import type {
  WsClientMappingRepository,
  WsClientMappingResult,
} from "./ws-client-mapping-repository";
import {
  WS_AUTHORIZATION_REVOKED_REASON,
  WS_CLOSE_AUTHORIZATION_REVOKED,
} from "@open-inspect/shared/types/websocket";

/** Configuration for the WebSocket manager. */
export interface WebSocketManagerConfig {
  authTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

/** Manages session sockets, client identity, and expiring authorization leases. */
export interface SessionWebSocketManager {
  /** Accept a client WebSocket with a wsId tag for hibernation recovery. */
  acceptClientSocket(ws: SessionWebSocket, wsId: string): void;

  /**
   * Accept a sandbox WebSocket as the session's active bridge: persist its
   * identity, then close every other sandbox socket.
   */
  acceptAndSetSandboxSocket(ws: SessionWebSocket, sandboxId?: string): { replaced: boolean };

  /** Whether `ws` is the sandbox socket the session currently dispatches to. */
  isActiveSandboxSocket(ws: SessionWebSocket): boolean;

  /** Parse a WebSocket's tags to determine its kind and identity. */
  classify(ws: SessionWebSocket): ConnectionClassification;

  /**
   * Get the active sandbox socket, recovering from hibernation if needed.
   * Validates sandbox ID against the repository during hibernation recovery.
   */
  getSandboxSocket(): SessionWebSocket | null;

  /** Clear the in-memory sandbox socket reference. */
  clearSandboxSocket(): void;

  /**
   * Revoke the persisted dispatch authority, then close every sandbox socket
   * without consulting the sandbox status. Nothing dispatches from, or is
   * recovered as, the bridge until the next accept.
   */
  detachSandboxSocket(code: number, reason: string): void;

  /**
   * Drop the in-memory pointer for a closing sandbox socket. Returns whether
   * it was the active socket — whether its close is the loss of the session's
   * bridge rather than the tail of a replacement.
   */
  clearSandboxSocketIfMatch(ws: SessionWebSocket): boolean;

  setClient(ws: SessionWebSocket, info: ClientInfo): void;
  removeClient(ws: SessionWebSocket): ClientInfo | null;

  /** Schedule, synchronize, and atomically publish a client authorization lease. */
  activateClient(
    ws: SessionWebSocket,
    info: ClientInfo,
    synchronize: () => boolean
  ): Promise<boolean>;

  /** Return a live client or its persisted hibernation mapping, rejecting expired leases. */
  lookupClient(ws: SessionWebSocket): ClientLookup;

  /** Close expired sockets, delete expired mappings, and schedule the next lease deadline. */
  expireAuthorizationLeases(now: number): Promise<void>;

  setClientSynchronizing(ws: SessionWebSocket, synchronizing: boolean): void;
  isClientSynchronizing(ws: SessionWebSocket): boolean;
  /** Return whether the client has an unexpired authorization lease. */
  isClientAuthenticated(ws: SessionWebSocket): boolean;

  /** Check if a wsId has a persisted mapping (used by auth timeout). */
  hasPersistedMapping(wsId: string): boolean;

  send(ws: SessionWebSocket, message: string | object): boolean;
  close(ws: SessionWebSocket, code: number, reason: string): void;

  /** Visit client sockets, optionally limiting the visit to unexpired authorization leases. */
  forEachClientSocket(
    mode: "all_clients" | "authenticated_only",
    fn: (ws: SessionWebSocket) => void
  ): void;

  enforceAuthTimeout(ws: SessionWebSocket, wsId: string): Promise<void>;
  getAuthenticatedClients(): IterableIterator<ClientInfo>;
  getConnectedClientCount(): number;
}

/** Result of resolving a client while enforcing its authorization lease. */
export type ClientLookup =
  | { kind: "cached"; client: ClientInfo }
  | { kind: "recovered"; mapping: WsClientMappingResult }
  | { kind: "authorization_rejected" }
  | { kind: "missing" };

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/** Session WebSocket manager with persisted authorization leases. */
export class SessionWebSocketManagerImpl implements SessionWebSocketManager {
  private clients = new Map<SessionWebSocket, ClientInfo>();
  private synchronizingClients = new Set<SessionWebSocket>();
  private sandboxWs: SessionWebSocket | null = null;

  /** Create a WebSocket manager over the host's sockets and persisted client mappings. */
  constructor(
    private readonly host: SessionWebSocketHost,
    private readonly sandboxRepository: SandboxRepository,
    private readonly wsClientMappingRepository: WsClientMappingRepository,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly log: Logger,
    private readonly config: WebSocketManagerConfig
  ) {}

  // -------------------------------------------------------------------------
  // Accept
  // -------------------------------------------------------------------------

  acceptClientSocket(ws: SessionWebSocket, wsId: string): void {
    this.host.adopt(ws, [`wsid:${wsId}`]);
  }

  acceptAndSetSandboxSocket(ws: SessionWebSocket, sandboxId?: string): { replaced: boolean } {
    const socketId = `sbws-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const tags = ["sandbox", ...(sandboxId ? [`sid:${sandboxId}`] : []), `socket:${socketId}`];
    this.host.adopt(ws, tags);
    // Advance the persisted identity before anything else observes the new
    // socket: from here on every earlier bridge socket is refused at dispatch
    // whether or not its close below completes, and recovery after a restart
    // re-selects this socket by its tag.
    this.sandboxRepository.setActiveSocketId(socketId);

    let replaced = false;
    // Close every other live sandbox socket, not only the cached one: after
    // hibernation the pointer is gone but the old bridge's socket is still
    // attached under its tags.
    const existingSockets = new Set(this.host.sockets("sandbox"));
    if (this.sandboxWs) existingSockets.add(this.sandboxWs);
    for (const existing of existingSockets) {
      if (existing === ws || !isSocketOpen(existing)) continue;
      try {
        existing.close(1000, "New sandbox connecting");
        replaced = true;
      } catch {
        // Ignore errors closing old WebSocket
      }
    }

    this.sandboxWs = ws;
    return { replaced };
  }

  // -------------------------------------------------------------------------
  // Classification
  // -------------------------------------------------------------------------

  classify(ws: SessionWebSocket): ConnectionClassification {
    const tags = this.host.tags(ws);
    if (tags.includes("sandbox")) {
      const sidTag = tags.find((t) => t.startsWith("sid:"));
      const socketTag = tags.find((t) => t.startsWith("socket:"));
      return { kind: "sandbox", sandboxId: sidTag?.slice(4), socketId: socketTag?.slice(7) };
    }
    const wsIdTag = tags.find((t) => t.startsWith("wsid:"));
    return { kind: "client", wsId: wsIdTag?.slice(5) };
  }

  // -------------------------------------------------------------------------
  // Sandbox socket
  // -------------------------------------------------------------------------

  isActiveSandboxSocket(ws: SessionWebSocket): boolean {
    return this.isAuthoritative(this.classify(ws), this.sandboxRepository.getSandbox());
  }

  /**
   * Whether a sandbox socket is the one the row names. The row's
   * `active_socket_id` is three-valued: a tag id matches exactly that socket;
   * `''` (revoked by detach or a spawn reservation) matches nothing; NULL
   * means the row predates persisted identities, and then an untagged socket
   * for the row's sandbox stays authoritative until the next accept.
   */
  private isAuthoritative(parsed: ConnectionClassification, sandbox: SandboxRow | null): boolean {
    if (parsed.kind !== "sandbox" || !sandbox) return false;
    if (sandbox.active_socket_id === null) {
      return (
        parsed.socketId === undefined &&
        (!sandbox.modal_sandbox_id || parsed.sandboxId === sandbox.modal_sandbox_id)
      );
    }
    return parsed.socketId !== undefined && parsed.socketId === sandbox.active_socket_id;
  }

  getSandboxSocket(): SessionWebSocket | null {
    const sandbox = this.sandboxRepository.getSandbox();
    const expectedSandboxId = sandbox?.modal_sandbox_id;

    // If the sandbox is in a terminal state, don't re-adopt stale WebSockets.
    // After inactivity timeout or heartbeat stale, the DO closes the WS and sets
    // status to stopped/stale, but the close handshake may not complete before
    // hibernation. On wake, the zombie WS still appears OPEN — skip it.
    const terminalStatuses = ["stopped", "failed", "stale"];
    if (sandbox && terminalStatuses.includes(sandbox.status)) {
      this.sandboxWs = null;
      // Close any lingering sandbox WebSockets so they don't persist
      for (const ws of this.host.sockets()) {
        const parsed = this.classify(ws);
        if (parsed.kind === "sandbox") {
          this.close(ws, 1000, "Sandbox terminated");
        }
      }
      return null;
    }

    if (this.sandboxWs && isSocketOpen(this.sandboxWs)) {
      if (this.isAuthoritative(this.classify(this.sandboxWs), sandbox)) {
        return this.sandboxWs;
      }
      this.close(this.sandboxWs, 1000, "Sandbox identity changed");
      this.sandboxWs = null;
    }

    // Recovery after a restart: the pointer is gone but the accepted sockets
    // and their tags survive. Only the socket carrying the persisted active
    // identity is re-adopted — a same-sandbox socket it replaced may still be
    // open while its close completes, and must not win for coming first.
    for (const ws of this.host.sockets()) {
      const parsed = this.classify(ws);
      if (parsed.kind !== "sandbox" || !isSocketOpen(ws)) continue;

      if (expectedSandboxId && parsed.sandboxId !== expectedSandboxId) {
        this.log.debug("Skipping WS with wrong sandbox ID", {
          tag_sandbox_id: parsed.sandboxId,
          expected_sandbox_id: expectedSandboxId,
        });
        this.close(ws, 1000, "Sandbox identity changed");
        continue;
      }
      if (!this.isAuthoritative(parsed, sandbox)) continue;

      this.log.info("Recovered sandbox WebSocket from hibernation");
      this.sandboxWs = ws;
      return ws;
    }

    return null;
  }

  clearSandboxSocket(): void {
    this.sandboxWs = null;
  }

  detachSandboxSocket(code: number, reason: string): void {
    const sockets = new Set<SessionWebSocket>();
    if (this.sandboxWs) sockets.add(this.sandboxWs);
    for (const ws of this.host.sockets()) {
      if (this.classify(ws).kind === "sandbox") sockets.add(ws);
    }
    // Revoke before closing: a trailing frame from a detached socket, or a
    // restart that still finds it open, must not find the row naming it.
    this.sandboxRepository.revokeActiveSocketId();
    this.sandboxWs = null;
    for (const ws of sockets) this.close(ws, code, reason);
  }

  clearSandboxSocketIfMatch(ws: SessionWebSocket): boolean {
    const active = this.isActiveSandboxSocket(ws);
    if (active || this.sandboxWs === ws) this.sandboxWs = null;
    return active;
  }

  // -------------------------------------------------------------------------
  // Client identity registry
  // -------------------------------------------------------------------------

  setClient(ws: SessionWebSocket, info: ClientInfo): void {
    this.clients.set(ws, info);
  }

  removeClient(ws: SessionWebSocket): ClientInfo | null {
    return this.teardownClient(ws, this.classify(ws));
  }

  // -------------------------------------------------------------------------
  // Hibernation recovery for client identity
  // -------------------------------------------------------------------------

  /** Return cached or persisted client state, closing the socket if its lease expired. */
  lookupClient(ws: SessionWebSocket): ClientLookup {
    const client = this.clients.get(ws);
    if (client) {
      if (client.authorizationExpiresAt <= Date.now()) {
        this.rejectExpiredAuthorization(ws, this.classify(ws));
        return { kind: "authorization_rejected" };
      }
      return { kind: "cached", client };
    }

    const parsed = this.classify(ws);
    if (parsed.kind !== "client" || !parsed.wsId) return { kind: "missing" };
    const mapping = this.wsClientMappingRepository.getWsClientMapping(parsed.wsId);
    if (!mapping) return { kind: "missing" };
    if (mapping.authorization_expires_at <= Date.now()) {
      this.rejectExpiredAuthorization(ws, parsed);
      return { kind: "authorization_rejected" };
    }
    return { kind: "recovered", mapping };
  }

  /** Schedule and synchronize before publishing persistent and in-memory identity together. */
  async activateClient(
    ws: SessionWebSocket,
    info: ClientInfo,
    synchronize: () => boolean
  ): Promise<boolean> {
    const parsed = this.classify(ws);
    if (parsed.kind !== "client" || !parsed.wsId) {
      throw new Error("Cannot activate a client without a WebSocket ID");
    }
    await this.alarmScheduler.schedule(info.authorizationExpiresAt);
    if (!isSocketOpen(ws) || info.authorizationExpiresAt <= Date.now()) {
      throw new Error("Cannot activate a closed client or an expired authorization lease");
    }
    // No await is allowed from snapshot send through both identity writes: a
    // client that receives `subscribed` must be immediately usable by the next
    // event delivered for this socket.
    if (!synchronize()) return false;
    this.wsClientMappingRepository.upsertWsClientMapping({
      wsId: parsed.wsId,
      participantId: info.participantId,
      clientId: info.clientId,
      createdAt: Date.now(),
      authorizationExpiresAt: info.authorizationExpiresAt,
    });
    this.clients.set(ws, info);
    this.log.debug("Stored ws_client_mapping", {
      ws_id: parsed.wsId,
      participant_id: info.participantId,
    });
    return true;
  }

  /** Close and remove expired client leases, then schedule the next deadline. */
  async expireAuthorizationLeases(now: number): Promise<void> {
    for (const ws of this.host.sockets()) {
      const parsed = this.classify(ws);
      if (parsed.kind !== "client") continue;
      const expiresAt = this.authorizationExpiry(ws, parsed);
      if (expiresAt !== null && expiresAt <= now) {
        this.rejectExpiredAuthorization(ws, parsed);
      }
    }
    this.wsClientMappingRepository.deleteExpiredMappings(now);
    const nextExpiry = this.wsClientMappingRepository.getNextAuthorizationExpiry();
    if (nextExpiry !== null) await this.alarmScheduler.schedule(nextExpiry);
  }

  setClientSynchronizing(ws: SessionWebSocket, synchronizing: boolean): void {
    if (synchronizing) this.synchronizingClients.add(ws);
    else this.synchronizingClients.delete(ws);
  }

  isClientSynchronizing(ws: SessionWebSocket): boolean {
    return this.synchronizingClients.has(ws);
  }

  /** Return whether the client has an unexpired authorization lease. */
  isClientAuthenticated(ws: SessionWebSocket): boolean {
    return this.isAuthenticated(ws, this.classify(ws));
  }

  hasPersistedMapping(wsId: string): boolean {
    return this.wsClientMappingRepository.hasWsClientMapping(wsId);
  }

  // -------------------------------------------------------------------------
  // Send / close
  // -------------------------------------------------------------------------

  send(ws: SessionWebSocket, message: string | object): boolean {
    try {
      if (!isSocketOpen(ws)) {
        this.log.debug("Cannot send: WebSocket not open", { ready_state: ws.readyState });
        return false;
      }
      const data = typeof message === "string" ? message : JSON.stringify(message);
      ws.send(data);
      return true;
    } catch (e) {
      this.log.warn("WebSocket send failed", { error: e instanceof Error ? e : String(e) });
      return false;
    }
  }

  close(ws: SessionWebSocket, code: number, reason: string): void {
    try {
      ws.close(code, reason);
    } catch {
      // WebSocket may already be closed
    }
  }

  // -------------------------------------------------------------------------
  // Broadcast
  // -------------------------------------------------------------------------

  /** Visit client sockets, optionally limiting the visit to unexpired authorization leases. */
  forEachClientSocket(
    mode: "all_clients" | "authenticated_only",
    fn: (ws: SessionWebSocket) => void
  ): void {
    for (const ws of this.host.sockets()) {
      const parsed = this.classify(ws);
      if (parsed.kind === "sandbox") continue;

      if (mode === "all_clients") {
        fn(ws);
      } else if (this.isAuthenticated(ws, parsed)) {
        fn(ws);
      }
    }
  }

  /**
   * Check whether a client socket has authentication evidence,
   * either in-memory or via persisted DB mapping (post-hibernation).
   */
  private isAuthenticated(ws: SessionWebSocket, parsed: ConnectionClassification): boolean {
    const expiresAt = this.authorizationExpiry(ws, parsed);
    if (expiresAt === null) return false;
    if (expiresAt > Date.now()) return true;
    this.rejectExpiredAuthorization(ws, parsed);
    return false;
  }

  private authorizationExpiry(
    ws: SessionWebSocket,
    parsed: ConnectionClassification
  ): number | null {
    const client = this.clients.get(ws);
    if (client) return client.authorizationExpiresAt;
    if (parsed.kind !== "client" || !parsed.wsId) return null;
    const mapping = this.wsClientMappingRepository.getWsClientMapping(parsed.wsId);
    return mapping?.authorization_expires_at ?? null;
  }

  private rejectExpiredAuthorization(ws: SessionWebSocket, parsed: ConnectionClassification): void {
    this.teardownClient(ws, parsed);
    this.close(ws, WS_CLOSE_AUTHORIZATION_REVOKED, WS_AUTHORIZATION_REVOKED_REASON);
  }

  /** Remove every representation of a client before callers notify or close it. */
  private teardownClient(
    ws: SessionWebSocket,
    parsed: ConnectionClassification
  ): ClientInfo | null {
    const client = this.clients.get(ws) ?? null;
    this.clients.delete(ws);
    this.synchronizingClients.delete(ws);
    if (parsed.kind === "client" && parsed.wsId) {
      this.wsClientMappingRepository.deleteWsClientMapping(parsed.wsId);
    }
    return client;
  }

  // -------------------------------------------------------------------------
  // Auth timeout enforcement
  // -------------------------------------------------------------------------

  async enforceAuthTimeout(ws: SessionWebSocket, wsId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.config.authTimeoutMs));

    if (!isSocketOpen(ws)) return;
    if (this.clients.has(ws)) return;
    if (this.synchronizingClients.has(ws)) return;
    if (this.hasPersistedMapping(wsId)) return;

    this.log.warn("ws.connect", {
      event: "ws.connect",
      ws_type: "client",
      outcome: "auth_timeout",
      ws_id: wsId,
      timeout_ms: this.config.authTimeoutMs,
    });
    this.close(ws, 4008, "Authentication timeout");
  }

  *getAuthenticatedClients(): IterableIterator<ClientInfo> {
    for (const [ws, client] of this.clients) {
      if (client.authorizationExpiresAt <= Date.now()) {
        this.rejectExpiredAuthorization(ws, this.classify(ws));
        continue;
      }
      yield client;
    }
  }

  getConnectedClientCount(): number {
    let count = 0;
    for (const ws of this.host.sockets()) {
      const parsed = this.classify(ws);
      if (parsed.kind !== "sandbox" && isSocketOpen(ws)) {
        count++;
      }
    }
    return count;
  }
}
