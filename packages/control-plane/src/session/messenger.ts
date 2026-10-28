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
import type { SandboxStateReader } from "./sandbox-ports";

// Internal notification only: adapt to an existing wire type for older web bundles.
type SessionBroadcast =
  | ServerMessage
  | {
      type: "sandbox_connection";
      status: "connected" | "reconnecting";
    };

/**
 * The slice of the socket registry delivery needs: client fan-out and the
 * sandbox send path. Typed narrowly so this seam cannot grow accidental
 * coupling to admission, persistence, or teardown operations.
 */
type DeliverySockets = Pick<
  SessionWebSocketManager,
  "forEachClientSocket" | "getSandboxCommandTarget" | "send"
>;

export class SandboxDeliveryUnavailableError extends Error {
  constructor(message = "No sandbox connected") {
    super(message);
    this.name = "SandboxDeliveryUnavailableError";
  }
}

export interface SessionMessenger {
  /** Broadcast a message to all authenticated client sockets. */
  broadcast(message: SessionBroadcast): void;

  /**
   * Send a command to the ready sandbox; rejects when delivery is unavailable,
   * which includes a bridge that is attached but still booting.
   */
  sendToSandbox(command: SandboxCommand): Promise<void>;
}

export class SessionMessengerImpl implements SessionMessenger {
  constructor(
    private readonly wsManager: DeliverySockets,
    private readonly sandboxRepository: SandboxStateReader
  ) {}

  broadcast(message: SessionBroadcast): void {
    if (message.type === "sandbox_connection") {
      const sandbox = this.sandboxRepository.getSandbox();
      if (!sandbox) return;
      message = {
        type: "sandbox_status",
        status: sandbox.status,
        connectionStatus: message.status,
      };
    }
    // Best effort; the registry handles per-client send failures.
    this.wsManager.forEachClientSocket("authenticated_only", (ws) => {
      this.wsManager.send(ws, message);
    });
  }

  sendToSandbox(command: SandboxCommand): Promise<void> {
    const target = this.wsManager.getSandboxCommandTarget();
    if (target.kind !== "dispatch") return Promise.reject(new SandboxDeliveryUnavailableError());
    return this.wsManager.send(target.socket, command)
      ? Promise.resolve()
      : Promise.reject(new SandboxDeliveryUnavailableError("Failed to send message to sandbox"));
  }
}
