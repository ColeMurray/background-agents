import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SandboxCommand } from "./types";

export interface ConnectedParticipant {
  participantId: string;
  userId: string;
  name: string;
  avatar?: string;
  status: "active" | "idle" | "away";
  lastSeen: number;
}

export interface BrowserConnection {
  connectionId: string;
  clientId: string;
  participant: ConnectedParticipant;
}

export interface SandboxConnection {
  connectionId: string;
  sandboxId?: string;
}

export interface DisconnectReason {
  code: number;
  reason: string;
}

export class SandboxDeliveryUnavailableError extends Error {
  constructor(message = "No sandbox connected") {
    super(message);
    this.name = "SandboxDeliveryUnavailableError";
  }
}

/** Project one participant per identity from one or more browser connections. */
export function projectConnectedParticipants(
  connections: Iterable<ConnectedParticipant>
): ConnectedParticipant[] {
  const participants = new Map<string, ConnectedParticipant>();
  for (const connection of connections) {
    const existing = participants.get(connection.participantId);
    if (!existing) {
      participants.set(connection.participantId, {
        participantId: connection.participantId,
        userId: connection.userId,
        name: connection.name,
        avatar: connection.avatar,
        status: connection.status,
        lastSeen: connection.lastSeen,
      });
      continue;
    }
    if (connection.status === "active") existing.status = "active";
    if (connection.lastSeen > existing.lastSeen) existing.lastSeen = connection.lastSeen;
  }
  return Array.from(participants.values());
}

/** Platform-neutral connection and fan-out boundary consumed by the session engine. */
export interface SessionConnections {
  registerBrowser(input: BrowserConnection): Promise<void>;
  registerSandbox(input: SandboxConnection): Promise<void>;
  sendToSandbox(message: SandboxCommand): Promise<void>;
  broadcastToBrowsers(message: ServerMessage): Promise<void>;
  disconnectSandbox(reason: DisconnectReason): Promise<void>;
  listParticipants(): Promise<ConnectedParticipant[]>;
}

/** Deterministic connection adapter for application tests and non-WebSocket runtimes. */
export class InMemorySessionConnections implements SessionConnections {
  private readonly browsers = new Map<string, BrowserConnection>();
  private readonly browserMessages = new Map<string, ServerMessage[]>();
  private readonly sandboxMessages = new Map<string, SandboxCommand[]>();
  private readonly sandboxDisconnects = new Map<string, DisconnectReason>();
  private sandbox: SandboxConnection | null = null;

  registerBrowser(input: BrowserConnection): Promise<void> {
    this.browsers.set(input.connectionId, input);
    this.browserMessages.set(input.connectionId, []);
    return Promise.resolve();
  }

  registerSandbox(input: SandboxConnection): Promise<void> {
    this.sandbox = input;
    if (!this.sandboxMessages.has(input.connectionId)) {
      this.sandboxMessages.set(input.connectionId, []);
    }
    return Promise.resolve();
  }

  sendToSandbox(message: SandboxCommand): Promise<void> {
    if (!this.sandbox) return Promise.reject(new SandboxDeliveryUnavailableError());
    this.sandboxMessages.get(this.sandbox.connectionId)!.push(message);
    return Promise.resolve();
  }

  broadcastToBrowsers(message: ServerMessage): Promise<void> {
    for (const connectionId of this.browsers.keys()) {
      this.browserMessages.get(connectionId)!.push(message);
    }
    return Promise.resolve();
  }

  disconnectSandbox(reason: DisconnectReason): Promise<void> {
    if (this.sandbox) this.sandboxDisconnects.set(this.sandbox.connectionId, reason);
    this.sandbox = null;
    return Promise.resolve();
  }

  listParticipants(): Promise<ConnectedParticipant[]> {
    return Promise.resolve(
      projectConnectedParticipants(
        Array.from(this.browsers.values(), ({ participant }) => participant)
      )
    );
  }

  getBrowserMessages(connectionId: string): readonly ServerMessage[] {
    return this.browserMessages.get(connectionId) ?? [];
  }

  getSandboxMessages(connectionId = this.sandbox?.connectionId): readonly SandboxCommand[] {
    return connectionId ? (this.sandboxMessages.get(connectionId) ?? []) : [];
  }

  getSandboxDisconnect(connectionId: string): DisconnectReason | undefined {
    return this.sandboxDisconnects.get(connectionId);
  }

  flush(): Promise<void> {
    return Promise.resolve();
  }
}
