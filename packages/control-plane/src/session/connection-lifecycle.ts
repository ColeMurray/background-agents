import type { SandboxStatus } from "@open-inspect/shared/types/sessions";
import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { Logger } from "../logger";
import { isSandboxReconnectBlockedStatus } from "../sandbox/lifecycle/decisions";
import type { SessionConnectionKind, SessionRuntimeClient } from "./runtime-contracts";

export interface SessionConnectionLifecycleDeps<Connection, Client extends SessionRuntimeClient> {
  getLogger: () => Logger;
  classifyConnection: (connection: Connection) => SessionConnectionKind;
  close: (connection: Connection, code: number, reason: string) => void;
  closeOnError: (connection: Connection) => void;
  clearSandboxConnectionIfMatch: (connection: Connection) => boolean;
  getSandboxStatus: () => SandboxStatus | undefined;
  scheduleDisconnectCheck: () => Promise<void>;
  removeClient: (connection: Connection) => Client | null;
  hasAuthenticatedParticipant: (participantId: string) => boolean;
  broadcastPresence: () => void;
  broadcast: (message: ServerMessage) => void;
}

/** Applies disconnect policy independently of the underlying socket runtime. */
export class SessionConnectionLifecycle<Connection, Client extends SessionRuntimeClient> {
  constructor(private readonly deps: SessionConnectionLifecycleDeps<Connection, Client>) {}

  async handleClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    const classified = this.deps.classifyConnection(connection);

    try {
      if (classified.kind === "sandbox") {
        if (!this.deps.clearSandboxConnectionIfMatch(connection)) {
          this.deps.getLogger().debug("Ignoring close for replaced sandbox socket", { code });
          return;
        }

        const sandboxStatus = this.deps.getSandboxStatus();
        const reconnectBlocked =
          sandboxStatus !== undefined && isSandboxReconnectBlockedStatus(sandboxStatus);
        if (!reconnectBlocked) {
          this.deps.getLogger().warn("Sandbox WebSocket disconnected; awaiting reconnect", {
            event: "sandbox.disconnected",
            code,
            reason,
            was_clean: wasClean,
            sandbox_status: sandboxStatus,
            sandbox_id: classified.sandboxId,
          });
          await this.deps.scheduleDisconnectCheck();
        }
      } else {
        const client = this.deps.removeClient(connection);
        if (client) {
          if (this.deps.hasAuthenticatedParticipant(client.participantId)) {
            this.deps.broadcastPresence();
          } else {
            this.deps.broadcast({ type: "presence_leave", userId: client.userId });
          }
        }
      }
    } finally {
      this.deps.close(connection, code, reason);
    }
  }

  handleError(connection: Connection, error: Error): void {
    this.deps.getLogger().error("WebSocket error", { error });
    this.deps.closeOnError(connection);
  }
}
