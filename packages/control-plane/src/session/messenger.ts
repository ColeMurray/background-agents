/**
 * SessionMessenger — higher-level session messaging on top of the
 * platform-neutral session connection port.
 */

import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SandboxCommand } from "./types";
import type { SessionConnections } from "./connections";

export interface SessionMessenger {
  /** Broadcast a message to all authenticated client sockets. */
  broadcast(message: ServerMessage): void;

  /** Send a command to the active sandbox; rejects when delivery is unavailable. */
  sendToSandbox(command: SandboxCommand): Promise<void>;
}

export class SessionMessengerImpl implements SessionMessenger {
  constructor(private readonly connections: SessionConnections) {}

  broadcast(message: ServerMessage): void {
    void this.connections.broadcastToBrowsers(message).catch(() => {
      // Broadcast delivery is best effort; connection adapters handle per-client failures.
    });
  }

  sendToSandbox(command: SandboxCommand): Promise<void> {
    return this.connections.sendToSandbox(command);
  }
}
