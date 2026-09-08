/**
 * SessionMessenger — the session's outbound transport seam: browser fan-out
 * and sandbox command delivery over the WebSocket registry.
 *
 * This is the single higher-level delivery port. Consumers that need
 * connection-addressed operations (reply to one client socket, presence-check
 * a captured sandbox socket before a claim) stay on `SessionWebSocketManager`
 * deliberately: those flows are socket-identity-coupled and a
 * connection-anonymous port cannot express them faithfully.
 */

import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SandboxCommand } from "./types";
import type { SessionWebSocketManager } from "./websocket-manager";

/**
 * The slice of the socket registry delivery needs: client fan-out and the
 * sandbox send path. Typed narrowly so this seam cannot grow accidental
 * coupling to admission, persistence, or teardown operations.
 */
type DeliverySockets = Pick<
  SessionWebSocketManager,
  "forEachClientSocket" | "getSandboxSocket" | "send"
>;

export class SandboxDeliveryUnavailableError extends Error {
  constructor(message = "No sandbox connected") {
    super(message);
    this.name = "SandboxDeliveryUnavailableError";
  }
}

export interface SessionMessenger {
  /** Broadcast a message to all authenticated client sockets. */
  broadcast(message: ServerMessage): void;

  /** Send a command to the active sandbox; rejects when delivery is unavailable. */
  sendToSandbox(command: SandboxCommand): Promise<void>;
}

export class SessionMessengerImpl implements SessionMessenger {
  constructor(private readonly wsManager: DeliverySockets) {}

  broadcast(message: ServerMessage): void {
    // Best effort; the registry handles per-client send failures.
    this.wsManager.forEachClientSocket("authenticated_only", (ws) => {
      this.wsManager.send(ws, message);
    });
  }

  sendToSandbox(command: SandboxCommand): Promise<void> {
    const ws = this.wsManager.getSandboxSocket();
    if (!ws) return Promise.reject(new SandboxDeliveryUnavailableError());
    return this.wsManager.send(ws, command)
      ? Promise.resolve()
      : Promise.reject(new SandboxDeliveryUnavailableError("Failed to send message to sandbox"));
  }
}
