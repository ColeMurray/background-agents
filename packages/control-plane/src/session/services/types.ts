/**
 * Service layer types and interfaces.
 */

import type { ClientInfo } from "../../types";

/**
 * WebSocketManager handles client connections and message broadcasting.
 */
export interface WebSocketManager {
  /**
   * Get all registered clients.
   */
  getClients(): Map<WebSocket, ClientInfo>;

  /**
   * Register a client WebSocket connection.
   */
  registerClient(ws: WebSocket, clientInfo: ClientInfo): void;

  /**
   * Remove a client WebSocket connection.
   */
  removeClient(ws: WebSocket): void;

  /**
   * Get the sandbox WebSocket connection.
   */
  getSandboxWebSocket(): WebSocket | null;

  /**
   * Set the sandbox WebSocket connection.
   */
  setSandboxWebSocket(ws: WebSocket | null): void;

  /**
   * Safely send a message to a WebSocket, handling errors.
   * @returns true if sent successfully, false otherwise
   */
  safeSend(ws: WebSocket, message: object | string): boolean;

  /**
   * Broadcast a message to all registered clients.
   */
  broadcast(message: object): void;
}

/**
 * PresenceManager handles building and broadcasting participant presence.
 */
export interface PresenceManager {
  /**
   * Build a presence list from connected clients.
   */
  buildPresenceList(clients: Map<WebSocket, ClientInfo>): ClientInfo[];

  /**
   * Broadcast presence update to all clients.
   */
  broadcastPresence(clients: Map<WebSocket, ClientInfo>): void;
}

/**
 * Callback for broadcasting messages to clients.
 */
export type BroadcastCallback = (message: object) => void;
