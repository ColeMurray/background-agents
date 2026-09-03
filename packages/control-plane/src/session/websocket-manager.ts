/**
 * SessionWebSocketManager — the session's socket registry over its
 * `SocketHost`.
 *
 * The manager owns socket identity, persistence, and authorization leases.
 * The connection authenticator builds ClientInfo and stores it here after
 * snapshot synchronization.
 */

import type { Logger } from "../logger";
import type { AlarmScheduler } from "../platform-ports";
import type { ClientInfo } from "../types";
import type { SocketHost } from "./platform";
import type { ConnectionClassification } from "./ports";
import type { SandboxRepository } from "./sandbox-repository";
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
  acceptClientSocket(ws: WebSocket, wsId: string): void;

  /**
   * Accept a sandbox WebSocket, close any existing sandbox socket, and set
   * as the active sandbox connection.
   */
  acceptAndSetSandboxSocket(ws: WebSocket, sandboxId?: string): { replaced: boolean };

  /** Parse a WebSocket's tags to determine its kind and identity. */
  classify(ws: WebSocket): ConnectionClassification;

  /**
   * Get the active sandbox socket, recovering from hibernation if needed.
   * Validates sandbox ID against the repository during hibernation recovery.
   */
  getSandboxSocket(): WebSocket | null;

  /** Clear the in-memory sandbox socket reference. */
  clearSandboxSocket(): void;

  /** Clear and close all active sandbox sockets without consulting persisted dispatch status. */
  detachSandboxSocket(code: number, reason: string): void;

  /** Clear sandbox socket only if ws matches current reference. Returns true if it was the active socket. */
  clearSandboxSocketIfMatch(ws: WebSocket): boolean;

  setClient(ws: WebSocket, info: ClientInfo): void;
  removeClient(ws: WebSocket): ClientInfo | null;

  /** Schedule, synchronize, and atomically publish a client authorization lease. */
  activateClient(ws: WebSocket, info: ClientInfo, synchronize: () => boolean): Promise<boolean>;

  /** Return a live client or its persisted hibernation mapping, rejecting expired leases. */
  lookupClient(ws: WebSocket): ClientLookup;

  /** Close expired sockets, delete expired mappings, and schedule the next lease deadline. */
  expireAuthorizationLeases(now: number): Promise<void>;

  setClientSynchronizing(ws: WebSocket, synchronizing: boolean): void;
  isClientSynchronizing(ws: WebSocket): boolean;
  /** Return whether the client has an unexpired authorization lease. */
  isClientAuthenticated(ws: WebSocket): boolean;

  /** Check if a wsId has a persisted mapping (used by auth timeout). */
  hasPersistedMapping(wsId: string): boolean;

  send(ws: WebSocket, message: string | object): boolean;
  close(ws: WebSocket, code: number, reason: string): void;

  /** Visit client sockets, optionally limiting the visit to unexpired authorization leases. */
  forEachClientSocket(
    mode: "all_clients" | "authenticated_only",
    fn: (ws: WebSocket) => void
  ): void;

  enforceAuthTimeout(ws: WebSocket, wsId: string): Promise<void>;
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
  private clients = new Map<WebSocket, ClientInfo>();
  private synchronizingClients = new Set<WebSocket>();
  private sandboxWs: WebSocket | null = null;

  /** Create a WebSocket manager over the host's sockets and persisted client mappings. */
  constructor(
    private readonly host: SocketHost,
    private readonly sandboxRepository: SandboxRepository,
    private readonly wsClientMappingRepository: WsClientMappingRepository,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly log: Logger,
    private readonly config: WebSocketManagerConfig
  ) {}

  // -------------------------------------------------------------------------
  // Accept
  // -------------------------------------------------------------------------

  acceptClientSocket(ws: WebSocket, wsId: string): void {
    this.host.accept(ws, [`wsid:${wsId}`]);
  }

  acceptAndSetSandboxSocket(ws: WebSocket, sandboxId?: string): { replaced: boolean } {
    const tags = ["sandbox", ...(sandboxId ? [`sid:${sandboxId}`] : [])];
    this.host.accept(ws, tags);

    let replaced = false;
    // Close every other live sandbox socket, not only the cached one: after
    // hibernation the pointer is gone but the old bridge's socket is still
    // attached under its tags.
    const existingSockets = new Set(this.host.sockets("sandbox"));
    if (this.sandboxWs) existingSockets.add(this.sandboxWs);
    for (const existing of existingSockets) {
      if (existing === ws || existing.readyState !== WebSocket.OPEN) continue;
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

  classify(ws: WebSocket): ConnectionClassification {
    const tags = this.host.tags(ws);
    if (tags.includes("sandbox")) {
      const sidTag = tags.find((t) => t.startsWith("sid:"));
      return { kind: "sandbox", sandboxId: sidTag?.slice(4) };
    }
    const wsIdTag = tags.find((t) => t.startsWith("wsid:"));
    return { kind: "client", wsId: wsIdTag?.slice(5) };
  }

  // -------------------------------------------------------------------------
  // Sandbox socket
  // -------------------------------------------------------------------------

  getSandboxSocket(): WebSocket | null {
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

    if (this.sandboxWs?.readyState === WebSocket.OPEN) {
      const cached = this.classify(this.sandboxWs);
      if (
        !expectedSandboxId ||
        (cached.kind === "sandbox" && cached.sandboxId === expectedSandboxId)
      ) {
        return this.sandboxWs;
      }
      this.close(this.sandboxWs, 1000, "Sandbox identity changed");
      this.sandboxWs = null;
    }

    // Hibernation recovery: scan all WebSockets, validate sandbox identity

    for (const ws of this.host.sockets()) {
      const parsed = this.classify(ws);
      if (parsed.kind !== "sandbox" || ws.readyState !== WebSocket.OPEN) continue;

      if (expectedSandboxId && parsed.sandboxId !== expectedSandboxId) {
        this.log.debug("Skipping WS with wrong sandbox ID", {
          tag_sandbox_id: parsed.sandboxId,
          expected_sandbox_id: expectedSandboxId,
        });
        this.close(ws, 1000, "Sandbox identity changed");
        continue;
      }

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
    const sockets = new Set<WebSocket>();
    if (this.sandboxWs) sockets.add(this.sandboxWs);
    for (const ws of this.host.sockets()) {
      if (this.classify(ws).kind === "sandbox") sockets.add(ws);
    }
    this.sandboxWs = null;
    for (const ws of sockets) this.close(ws, code, reason);
  }

  clearSandboxSocketIfMatch(ws: WebSocket): boolean {
    if (this.sandboxWs === ws) {
      this.sandboxWs = null;
      return true;
    }
    // sandboxWs is null (post-hibernation or already cleared) — treat as active.
    // The only definitive "replaced" signal is sandboxWs pointing to a different socket.
    return this.sandboxWs === null;
  }

  // -------------------------------------------------------------------------
  // Client identity registry
  // -------------------------------------------------------------------------

  setClient(ws: WebSocket, info: ClientInfo): void {
    this.clients.set(ws, info);
  }

  removeClient(ws: WebSocket): ClientInfo | null {
    return this.teardownClient(ws, this.classify(ws));
  }

  // -------------------------------------------------------------------------
  // Hibernation recovery for client identity
  // -------------------------------------------------------------------------

  /** Return cached or persisted client state, closing the socket if its lease expired. */
  lookupClient(ws: WebSocket): ClientLookup {
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
    ws: WebSocket,
    info: ClientInfo,
    synchronize: () => boolean
  ): Promise<boolean> {
    const parsed = this.classify(ws);
    if (parsed.kind !== "client" || !parsed.wsId) {
      throw new Error("Cannot activate a client without a WebSocket ID");
    }
    await this.alarmScheduler.schedule(info.authorizationExpiresAt);
    if (ws.readyState !== WebSocket.OPEN || info.authorizationExpiresAt <= Date.now()) {
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

  setClientSynchronizing(ws: WebSocket, synchronizing: boolean): void {
    if (synchronizing) this.synchronizingClients.add(ws);
    else this.synchronizingClients.delete(ws);
  }

  isClientSynchronizing(ws: WebSocket): boolean {
    return this.synchronizingClients.has(ws);
  }

  /** Return whether the client has an unexpired authorization lease. */
  isClientAuthenticated(ws: WebSocket): boolean {
    return this.isAuthenticated(ws, this.classify(ws));
  }

  hasPersistedMapping(wsId: string): boolean {
    return this.wsClientMappingRepository.hasWsClientMapping(wsId);
  }

  // -------------------------------------------------------------------------
  // Send / close
  // -------------------------------------------------------------------------

  send(ws: WebSocket, message: string | object): boolean {
    try {
      if (ws.readyState !== WebSocket.OPEN) {
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

  close(ws: WebSocket, code: number, reason: string): void {
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
    fn: (ws: WebSocket) => void
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
  private isAuthenticated(ws: WebSocket, parsed: ConnectionClassification): boolean {
    const expiresAt = this.authorizationExpiry(ws, parsed);
    if (expiresAt === null) return false;
    if (expiresAt > Date.now()) return true;
    this.rejectExpiredAuthorization(ws, parsed);
    return false;
  }

  private authorizationExpiry(ws: WebSocket, parsed: ConnectionClassification): number | null {
    const client = this.clients.get(ws);
    if (client) return client.authorizationExpiresAt;
    if (parsed.kind !== "client" || !parsed.wsId) return null;
    const mapping = this.wsClientMappingRepository.getWsClientMapping(parsed.wsId);
    return mapping?.authorization_expires_at ?? null;
  }

  private rejectExpiredAuthorization(ws: WebSocket, parsed: ConnectionClassification): void {
    this.teardownClient(ws, parsed);
    this.close(ws, WS_CLOSE_AUTHORIZATION_REVOKED, WS_AUTHORIZATION_REVOKED_REASON);
  }

  /** Remove every representation of a client before callers notify or close it. */
  private teardownClient(ws: WebSocket, parsed: ConnectionClassification): ClientInfo | null {
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

  async enforceAuthTimeout(ws: WebSocket, wsId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.config.authTimeoutMs));

    if (ws.readyState !== WebSocket.OPEN) return;
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
      if (parsed.kind !== "sandbox" && ws.readyState === WebSocket.OPEN) {
        count++;
      }
    }
    return count;
  }
}
