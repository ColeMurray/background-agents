import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { ClientInfo } from "../types";
import type {
  BrowserConnection,
  ConnectedParticipant,
  DisconnectReason,
  SandboxConnection,
  SessionConnections,
} from "../session/connections";
import {
  projectConnectedParticipants,
  SandboxDeliveryUnavailableError,
} from "../session/connections";
import type { SandboxCommand } from "../session/types";
import type { ConnectionClassification } from "../session/ports";

export interface DurableObjectSessionConnectionSockets {
  configureAutoPing(request: string, response: string): void;
  createUpgradeSockets(): { client: WebSocket; server: WebSocket };
  forEachClientSocket(
    mode: "all_clients" | "authenticated_only",
    fn: (ws: WebSocket) => void
  ): void;
  classify(ws: WebSocket): ConnectionClassification;
  setClient(ws: WebSocket, info: ClientInfo): void;
  persistClientMapping(wsId: string, participantId: string, clientId: string): void;
  getSandboxSocket(): WebSocket | null;
  send(ws: WebSocket, message: string | object): boolean;
  detachSandboxSocket(code: number, reason: string): void;
  getAuthenticatedClients(): IterableIterator<ClientInfo>;
}

/** Cloudflare Durable Object implementation of the session connection port. */
export class DurableObjectSessionConnections implements SessionConnections {
  constructor(private readonly sockets: DurableObjectSessionConnectionSockets) {
    this.sockets.configureAutoPing(
      JSON.stringify({ type: "ping" }),
      JSON.stringify({ type: "pong", timestamp: Date.now() })
    );
  }

  createUpgradeSockets(): { client: WebSocket; server: WebSocket } {
    return this.sockets.createUpgradeSockets();
  }

  registerBrowser(input: BrowserConnection): Promise<void> {
    let matchedSocket: WebSocket | null = null;
    this.sockets.forEachClientSocket("all_clients", (ws) => {
      const connection = this.sockets.classify(ws);
      if (connection.kind === "client" && connection.wsId === input.connectionId) {
        matchedSocket = ws;
      }
    });
    if (!matchedSocket) {
      return Promise.reject(new Error(`Browser connection ${input.connectionId} not found`));
    }

    this.sockets.setClient(matchedSocket, {
      ...input.participant,
      clientId: input.clientId,
      ws: matchedSocket,
    });
    this.sockets.persistClientMapping(
      input.connectionId,
      input.participant.participantId,
      input.clientId
    );
    return Promise.resolve();
  }

  registerSandbox(input: SandboxConnection): Promise<void> {
    const ws = this.sockets.getSandboxSocket();
    if (!ws) return Promise.reject(new Error(`Sandbox connection ${input.connectionId} not found`));
    const connection = this.sockets.classify(ws);
    if (
      connection.kind !== "sandbox" ||
      (input.sandboxId !== undefined && connection.sandboxId !== input.sandboxId)
    ) {
      return Promise.reject(new Error(`Sandbox connection ${input.connectionId} does not match`));
    }
    return Promise.resolve();
  }

  sendToSandbox(message: SandboxCommand): Promise<void> {
    const ws = this.sockets.getSandboxSocket();
    if (!ws) return Promise.reject(new SandboxDeliveryUnavailableError());
    return this.sockets.send(ws, message)
      ? Promise.resolve()
      : Promise.reject(new SandboxDeliveryUnavailableError("Failed to send message to sandbox"));
  }

  broadcastToBrowsers(message: ServerMessage): Promise<void> {
    this.sockets.forEachClientSocket("authenticated_only", (ws) => {
      this.sockets.send(ws, message);
    });
    return Promise.resolve();
  }

  disconnectSandbox(reason: DisconnectReason): Promise<void> {
    this.sockets.detachSandboxSocket(reason.code, reason.reason);
    return Promise.resolve();
  }

  listParticipants(): Promise<ConnectedParticipant[]> {
    return Promise.resolve(projectConnectedParticipants(this.sockets.getAuthenticatedClients()));
  }
}
