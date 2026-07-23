/**
 * SessionMessenger — higher-level session messaging on top of the
 * WebSocket registry: fan-out to authenticated clients and command
 * delivery to the sandbox socket.
 */

import type { ServerMessage } from "@open-inspect/shared";
import type { SandboxCommand } from "./types";
import type { SessionWebSocketManager } from "./websocket-manager";

export interface SessionMessenger {
  /** Broadcast a message to all authenticated client sockets. */
  broadcast(message: ServerMessage): void;

  /**
   * Send a command to the active sandbox socket. Returns false when no
   * sandbox is connected or the send fails.
   */
  sendToSandbox(command: SandboxCommand): boolean;
}

export class SessionMessengerImpl implements SessionMessenger {
  constructor(private readonly wsManager: SessionWebSocketManager) {}

  broadcast(message: ServerMessage): void {
    this.wsManager.forEachClientSocket("authenticated_only", (ws) => {
      this.wsManager.send(ws, message);
    });
  }

  sendToSandbox(command: SandboxCommand): boolean {
    const sandboxSocket = this.wsManager.getSandboxSocket();
    return sandboxSocket ? this.wsManager.send(sandboxSocket, command) : false;
  }
}
