import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SessionConnections } from "../session/connections";
import { SandboxDeliveryUnavailableError } from "../session/connections";
import type { SandboxCommand } from "../session/types";

export interface DurableObjectSessionConnectionSockets {
  configureAutoPing(request: string, response: string): void;
  createUpgradeSockets(): { client: WebSocket; server: WebSocket };
  forEachClientSocket(
    mode: "all_clients" | "authenticated_only",
    fn: (ws: WebSocket) => void
  ): void;
  getSandboxSocket(): WebSocket | null;
  send(ws: WebSocket, message: ServerMessage | SandboxCommand): boolean;
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

  sendToSandbox(message: SandboxCommand): Promise<void> {
    const ws = this.sockets.getSandboxSocket();
    if (!ws) return Promise.reject(new SandboxDeliveryUnavailableError());
    return this.sockets.send(ws, message)
      ? Promise.resolve()
      : Promise.reject(new SandboxDeliveryUnavailableError("send_failed"));
  }

  broadcastToBrowsers(message: ServerMessage): Promise<void> {
    this.sockets.forEachClientSocket("authenticated_only", (ws) => {
      this.sockets.send(ws, message);
    });
    return Promise.resolve();
  }
}
