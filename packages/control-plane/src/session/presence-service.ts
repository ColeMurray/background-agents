/**
 * PresenceService - Presence tracking and typing-triggered sandbox warming.
 *
 * Extracted from SessionDO to reduce its size. Handles:
 * - Building presence lists from the WebSocket manager's client registry
 * - Sending presence sync/update messages to individual or all clients
 * - Updating client presence status
 * - Proactive sandbox warming on typing indicators
 */

import type { Logger } from "../logger";
import type { ClientInfo, ServerMessage, ParticipantPresence } from "../types";

/**
 * Dependencies injected into PresenceService.
 * All state lives in the WebSocket manager — the service is stateless.
 */
export interface PresenceServiceDeps {
  getAuthenticatedClients: () => IterableIterator<ClientInfo>;
  getClientInfo: (ws: WebSocket) => ClientInfo | null;
  broadcast: (message: ServerMessage) => void;
  send: (ws: WebSocket, message: ServerMessage) => boolean;
  getSandboxSocket: () => WebSocket | null;
  isSpawning: () => boolean;
  spawnSandbox: () => Promise<void>;
  log: Logger;
}

export class PresenceService {
  private readonly deps: PresenceServiceDeps;

  constructor(deps: PresenceServiceDeps) {
    this.deps = deps;
  }

  /**
   * Get list of present participants.
   */
  getPresenceList(): ParticipantPresence[] {
    return Array.from(this.deps.getAuthenticatedClients()).map((c) => ({
      participantId: c.participantId,
      userId: c.userId,
      name: c.name,
      avatar: c.avatar,
      status: c.status,
      lastSeen: c.lastSeen,
    }));
  }

  /**
   * Send presence info to a specific client.
   */
  sendPresence(ws: WebSocket): void {
    const participants = this.getPresenceList();
    this.deps.send(ws, { type: "presence_sync", participants });
  }

  /**
   * Broadcast presence to all clients.
   */
  broadcastPresence(): void {
    const participants = this.getPresenceList();
    this.deps.broadcast({ type: "presence_update", participants });
  }

  /**
   * Update client presence status and broadcast.
   */
  updatePresence(
    ws: WebSocket,
    data: { status: "active" | "idle"; cursor?: { line: number; file: string } }
  ): void {
    const client = this.deps.getClientInfo(ws);
    if (client) {
      client.status = data.status;
      client.lastSeen = Date.now();
      this.broadcastPresence();
    }
  }

  /**
   * Handle typing indicator (warm sandbox proactively).
   */
  async handleTyping(): Promise<void> {
    if (!this.deps.getSandboxSocket()) {
      if (!this.deps.isSpawning()) {
        this.deps.broadcast({ type: "sandbox_warming" });
        await this.deps.spawnSandbox();
      }
    }
  }
}
