/**
 * SessionWebSocketManager — centralizes all Cloudflare WebSocket API usage
 * into a single, testable module.
 *
 * The manager is a registry for ClientInfo, not a factory. The DO builds
 * ClientInfo and stores it here via setClient/getClient.
 */

import type { Logger } from "../logger";
import type { ClientInfo } from "../types";
import type { SessionRepository, WsClientMappingResult } from "./repository";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** The two kinds of WebSocket connections the DO manages. */
export type WsKind = "client" | "sandbox";

/** Result of parsing a WebSocket's Cloudflare hibernation tags. */
export type ParsedTags =
  | { kind: "sandbox"; sandboxId?: string }
  | { kind: "client"; wsId?: string };

/** Configuration for the WebSocket manager. */
export interface WebSocketManagerConfig {
  authTimeoutMs: number;
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

export interface SessionWebSocketManager {
  /** Accept a client WebSocket with a wsId tag for hibernation recovery. */
  acceptClientSocket(ws: WebSocket, wsId: string): void;

  /**
   * Accept a sandbox WebSocket, close any existing sandbox socket, and set
   * as the active sandbox connection.
   */
  acceptAndSetSandboxSocket(ws: WebSocket, sandboxId?: string): { replaced: boolean };

  /** Parse a WebSocket's tags to determine its kind and identity. */
  classify(ws: WebSocket): ParsedTags;

  /**
   * Get the active sandbox socket, recovering from hibernation if needed.
   * Validates sandbox ID against the repository during hibernation recovery.
   */
  getSandboxSocket(): WebSocket | null;

  /** Clear the in-memory sandbox socket reference. */
  clearSandboxSocket(): void;

  setClient(ws: WebSocket, info: ClientInfo): void;
  getClient(ws: WebSocket): ClientInfo | null;
  removeClient(ws: WebSocket): ClientInfo | null;

  /** Returns raw DB mapping for hibernation recovery. The DO builds ClientInfo from this. */
  recoverClientMapping(ws: WebSocket): WsClientMappingResult | null;

  /** Persist ws-to-participant mapping for hibernation survival. */
  persistClientMapping(wsId: string, participantId: string, clientId: string): void;

  /** Check if a wsId has a persisted mapping (used by auth timeout). */
  hasPersistedMapping(wsId: string): boolean;

  send(ws: WebSocket, message: string | object): boolean;
  close(ws: WebSocket, code: number, reason: string): void;

  forEachClientSocket(
    mode: "all_clients" | "authenticated_only",
    fn: (ws: WebSocket) => void
  ): void;

  enforceAuthTimeout(ws: WebSocket, wsId: string): Promise<void>;
  enableAutoPingPong(): void;
  getAuthenticatedClients(): IterableIterator<ClientInfo>;
  getConnectedClientCount(): number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class SessionWebSocketManagerImpl implements SessionWebSocketManager {
  private clients = new Map<WebSocket, ClientInfo>();
  private sandboxWs: WebSocket | null = null;

  constructor(
    private readonly ctx: DurableObjectState,
    private readonly repository: SessionRepository,
    private readonly log: Logger,
    private readonly config: WebSocketManagerConfig
  ) {}

  // -------------------------------------------------------------------------
  // Accept
  // -------------------------------------------------------------------------

  acceptClientSocket(ws: WebSocket, wsId: string): void {
    this.ctx.acceptWebSocket(ws, [`wsid:${wsId}`]);
  }

  acceptAndSetSandboxSocket(ws: WebSocket, sandboxId?: string): { replaced: boolean } {
    const tags = ["sandbox", ...(sandboxId ? [`sid:${sandboxId}`] : [])];
    this.ctx.acceptWebSocket(ws, tags);

    let replaced = false;
    if (this.sandboxWs && this.sandboxWs !== ws) {
      try {
        if (this.sandboxWs.readyState === WebSocket.OPEN) {
          this.sandboxWs.close(1000, "New sandbox connecting");
          replaced = true;
        }
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

  classify(ws: WebSocket): ParsedTags {
    const tags = this.ctx.getTags(ws);
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
    if (this.sandboxWs?.readyState === WebSocket.OPEN) {
      return this.sandboxWs;
    }

    // Hibernation recovery: scan all WebSockets, validate sandbox identity
    const sandbox = this.repository.getSandbox();
    const expectedSandboxId = sandbox?.modal_sandbox_id;

    for (const ws of this.ctx.getWebSockets()) {
      const parsed = this.classify(ws);
      if (parsed.kind !== "sandbox" || ws.readyState !== WebSocket.OPEN) continue;

      if (expectedSandboxId && parsed.sandboxId && parsed.sandboxId !== expectedSandboxId) {
        this.log.debug("Skipping WS with wrong sandbox ID", {
          tag_sandbox_id: parsed.sandboxId,
          expected_sandbox_id: expectedSandboxId,
        });
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

  // -------------------------------------------------------------------------
  // Client identity registry
  // -------------------------------------------------------------------------

  setClient(ws: WebSocket, info: ClientInfo): void {
    this.clients.set(ws, info);
  }

  getClient(ws: WebSocket): ClientInfo | null {
    return this.clients.get(ws) ?? null;
  }

  removeClient(ws: WebSocket): ClientInfo | null {
    const client = this.clients.get(ws) ?? null;
    this.clients.delete(ws);
    return client;
  }

  // -------------------------------------------------------------------------
  // Hibernation recovery for client identity
  // -------------------------------------------------------------------------

  recoverClientMapping(ws: WebSocket): WsClientMappingResult | null {
    const parsed = this.classify(ws);
    if (parsed.kind !== "client" || !parsed.wsId) return null;
    return this.repository.getWsClientMapping(parsed.wsId);
  }

  persistClientMapping(wsId: string, participantId: string, clientId: string): void {
    this.repository.upsertWsClientMapping({
      wsId,
      participantId,
      clientId,
      createdAt: Date.now(),
    });
  }

  hasPersistedMapping(wsId: string): boolean {
    return this.repository.hasWsClientMapping(wsId);
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

  forEachClientSocket(
    mode: "all_clients" | "authenticated_only",
    fn: (ws: WebSocket) => void
  ): void {
    for (const ws of this.ctx.getWebSockets()) {
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
  private isAuthenticated(ws: WebSocket, parsed: ParsedTags): boolean {
    if (this.clients.has(ws)) return true;
    if (parsed.kind === "client" && parsed.wsId) {
      return this.repository.hasWsClientMapping(parsed.wsId);
    }
    return false;
  }

  // -------------------------------------------------------------------------
  // Auth timeout enforcement
  // -------------------------------------------------------------------------

  async enforceAuthTimeout(ws: WebSocket, wsId: string): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, this.config.authTimeoutMs));

    if (ws.readyState !== WebSocket.OPEN) return;
    if (this.clients.has(ws)) return;
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

  enableAutoPingPong(): void {
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong", timestamp: Date.now() })
      )
    );
  }

  getAuthenticatedClients(): IterableIterator<ClientInfo> {
    return this.clients.values();
  }

  getConnectedClientCount(): number {
    let count = 0;
    for (const ws of this.ctx.getWebSockets()) {
      const parsed = this.classify(ws);
      if (parsed.kind !== "sandbox" && ws.readyState === WebSocket.OPEN) {
        count++;
      }
    }
    return count;
  }
}
