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
import type { SessionMessenger } from "./messenger";

/**
 * Dependencies injected into PresenceService.
 * All state lives in the WebSocket manager — the service is stateless.
 */
export interface PresenceServiceDeps {
  getAuthenticatedClients: () => IterableIterator<ClientInfo>;
  getClientInfo: (ws: WebSocket) => ClientInfo | null;
  messenger: SessionMessenger;
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
   *
   * A single participant can hold multiple WebSocket connections (e.g. two
   * browser tabs), so we dedupe by participantId: any active socket marks the
   * participant active, and we take the most recent lastSeen across sockets.
   */
  getPresenceList(): ParticipantPresence[] {
    const byId = new Map<string, ParticipantPresence>();
    for (const c of this.deps.getAuthenticatedClients()) {
      const existing = byId.get(c.participantId);
      if (!existing) {
        byId.set(c.participantId, {
          participantId: c.participantId,
          userId: c.userId,
          name: c.name,
          avatar: c.avatar,
          status: c.status,
          lastSeen: c.lastSeen,
        });
        continue;
      }
      if (c.status === "active") existing.status = "active";
      if (c.lastSeen > existing.lastSeen) existing.lastSeen = c.lastSeen;
    }
    return Array.from(byId.values());
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
    this.deps.messenger.broadcast({ type: "presence_update", participants });
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
        this.deps.messenger.broadcast({ type: "sandbox_warming" });
        await this.deps.spawnSandbox();
      }
    }
  }
}
