import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type {
  BrowserConnection,
  ConnectedParticipant,
  DisconnectReason,
  SandboxConnection,
  SessionConnections,
} from "./connections";
import { projectConnectedParticipants, SandboxDeliveryUnavailableError } from "./connections";
import type { SandboxCommand } from "./types";
import type { SessionWebSocketManager } from "./websocket-manager";

/** Cloudflare Durable Object implementation of the session connection port. */
export class DurableObjectSessionConnections implements SessionConnections {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly wsManager: SessionWebSocketManager
  ) {
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(
        JSON.stringify({ type: "ping" }),
        JSON.stringify({ type: "pong", timestamp: Date.now() })
      )
    );
  }

  createUpgradeSockets(): { client: WebSocket; server: WebSocket } {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    return { client, server };
  }

  registerBrowser(input: BrowserConnection): Promise<void> {
    let matchedSocket: WebSocket | null = null;
    this.wsManager.forEachClientSocket("all_clients", (ws) => {
      const connection = this.wsManager.classify(ws);
      if (connection.kind === "client" && connection.wsId === input.connectionId) {
        matchedSocket = ws;
      }
    });
    if (!matchedSocket) {
      return Promise.reject(new Error(`Browser connection ${input.connectionId} not found`));
    }

    this.wsManager.setClient(matchedSocket, {
      ...input.participant,
      clientId: input.clientId,
      ws: matchedSocket,
    });
    this.wsManager.persistClientMapping(
      input.connectionId,
      input.participant.participantId,
      input.clientId
    );
    return Promise.resolve();
  }

  registerSandbox(input: SandboxConnection): Promise<void> {
    const ws = this.wsManager.getSandboxSocket();
    if (!ws) return Promise.reject(new Error(`Sandbox connection ${input.connectionId} not found`));
    const connection = this.wsManager.classify(ws);
    if (
      connection.kind !== "sandbox" ||
      (input.sandboxId !== undefined && connection.sandboxId !== input.sandboxId)
    ) {
      return Promise.reject(new Error(`Sandbox connection ${input.connectionId} does not match`));
    }
    return Promise.resolve();
  }

  sendToSandbox(message: SandboxCommand): Promise<void> {
    const ws = this.wsManager.getSandboxSocket();
    if (!ws) return Promise.reject(new SandboxDeliveryUnavailableError());
    return this.wsManager.send(ws, message)
      ? Promise.resolve()
      : Promise.reject(new SandboxDeliveryUnavailableError("Failed to send message to sandbox"));
  }

  broadcastToBrowsers(message: ServerMessage): Promise<void> {
    this.wsManager.forEachClientSocket("authenticated_only", (ws) => {
      this.wsManager.send(ws, message);
    });
    return Promise.resolve();
  }

  disconnectSandbox(reason: DisconnectReason): Promise<void> {
    this.wsManager.detachSandboxSocket(reason.code, reason.reason);
    return Promise.resolve();
  }

  listParticipants(): Promise<ConnectedParticipant[]> {
    return Promise.resolve(projectConnectedParticipants(this.wsManager.getAuthenticatedClients()));
  }
}
