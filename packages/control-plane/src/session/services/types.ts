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

/**
 * Callbacks for EventProcessor to avoid circular dependencies.
 */
export interface EventProcessorCallbacks {
  /**
   * Called when execution completes.
   */
  onExecutionComplete: (messageId: string, success: boolean) => Promise<void>;

  /**
   * Called to process the next message in the queue.
   */
  onProcessNextMessage: () => Promise<void>;

  /**
   * Called to trigger a snapshot.
   */
  triggerSnapshot: (reason: string) => Promise<void>;
}

/**
 * EventProcessor handles event storage and special event processing.
 */
export interface EventProcessor {
  /**
   * Process an event: store it, broadcast it, and handle special event types.
   */
  processEvent(event: { type: string; data?: unknown; message_id?: string }): Promise<void>;
}

/**
 * SandboxManager handles sandbox lifecycle and circuit breaker logic.
 */
export interface SandboxManager {
  /**
   * Spawn a new sandbox.
   */
  spawnSandbox(): Promise<void>;

  /**
   * Restore sandbox from snapshot.
   */
  restoreFromSnapshot(snapshotId: string): Promise<void>;

  /**
   * Check if sandbox can be spawned (circuit breaker check).
   */
  canSpawnSandbox(): boolean;

  /**
   * Trigger a snapshot.
   */
  triggerSnapshot(reason: string): Promise<void>;

  /**
   * Check if sandbox is inactive (> 30 minutes).
   */
  isInactive(): boolean;

  /**
   * Update sandbox status.
   */
  updateStatus(status: string): void;

  /**
   * Update heartbeat timestamp.
   */
  updateHeartbeat(): void;

  /**
   * Update activity timestamp.
   */
  updateActivity(): void;
}

/**
 * MessageQueue handles message queuing and processing.
 */
export interface MessageQueue {
  /**
   * Enqueue a new message with pending status.
   * @returns The created message ID
   */
  enqueue(data: { content: string; authorId: string; source: string }): Promise<string>;

  /**
   * Process the next pending message in the queue (FIFO).
   */
  processQueue(): Promise<void>;
}

/**
 * PRCreator handles pull request creation workflow.
 */
export interface PRCreator {
  /**
   * Create a pull request by pushing branch and creating PR on GitHub.
   */
  createPullRequest(data: { branch: string; title: string; body: string }): Promise<void>;

  /**
   * Find a participant with a valid GitHub access token.
   */
  findParticipantWithToken(): ParticipantRow | null;
}

/**
 * Import ParticipantRow type for PRCreator interface.
 */
import type { ParticipantRow } from "../types";
