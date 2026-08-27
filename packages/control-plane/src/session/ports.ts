/**
 * Ports consumed by the platform-neutral server stack (dispatcher, message
 * router, disconnect handler), generic over the connection type so the stack
 * unit-tests off-platform with plain values (see server.test.ts).
 *
 * These are deliberately separate from the delivery seam (`SessionMessenger`)
 * and the concrete registry (`SessionWebSocketManager`): the server stack
 * needs connection-addressed operations (classify THIS connection, reply to
 * THIS socket), which a connection-anonymous delivery port cannot express.
 */

/** Mutable state associated with one authenticated browser connection. */
export interface ConnectedClient {
  participantId: string;
  userId: string;
  lastFetchHistoryAtMs?: number;
}

/** Result of classifying an opaque runtime connection. */
export type ConnectionClassification =
  | { kind: "sandbox"; sandboxId?: string }
  | { kind: "client"; wsId?: string };

/** Wall and monotonic time sources used by session application code. */
export interface Clock {
  nowMs(): number;
  monotonicNowMs(): number;
}

/** Registry and transport operations over opaque runtime connections. */
export interface SocketRegistry<Connection, Client extends ConnectedClient> {
  classify(connection: Connection): ConnectionClassification;
  send(connection: Connection, message: ServerMessage): boolean;
  getClient(connection: Connection): Client | null;
  close(connection: Connection, code: number, reason: string): void;
  clearSandboxIfMatch(connection: Connection): boolean;
  removeClient(connection: Connection): Client | null;
  hasParticipant(participantId: string): boolean;
}

/** Participant-facing notifications emitted by disconnect policy. */
export interface SessionBroadcaster {
  broadcast(message: ServerMessage): void;
  broadcastPresence(): void;
}

/** Sandbox state needed to decide whether a disconnected bridge may reconnect. */
export interface SandboxDisconnectMonitor {
  getStatus(): SandboxStatus | undefined;
  scheduleCheck(): Promise<void>;
}
import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
