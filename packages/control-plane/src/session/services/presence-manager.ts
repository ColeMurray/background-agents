/**
 * PresenceManager implementation.
 */

import type { PresenceManager, BroadcastCallback } from "./types";
import type { ClientInfo } from "../../types";

interface PresenceManagerDependencies {
  broadcast: BroadcastCallback;
}

/**
 * Create a PresenceManager instance.
 */
export function createPresenceManager(deps: PresenceManagerDependencies): PresenceManager {
  const { broadcast } = deps;

  return {
    buildPresenceList(clients: Map<WebSocket, ClientInfo>): ClientInfo[] {
      const presence: ClientInfo[] = [];

      for (const [, clientInfo] of clients) {
        presence.push(clientInfo);
      }

      return presence;
    },

    broadcastPresence(clients: Map<WebSocket, ClientInfo>): void {
      try {
        const participants = this.buildPresenceList(clients);
        broadcast({
          type: "presence",
          participants,
        });
      } catch (error) {
        console.error("Failed to broadcast presence:", error);
      }
    },
  };
}
