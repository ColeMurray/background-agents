import type { Logger } from "../logger";
import { isSandboxReconnectBlockedStatus } from "../sandbox/lifecycle/decisions";
import type {
  ConnectedClient,
  SandboxDisconnectMonitor,
  SessionBroadcaster,
  SocketRegistry,
} from "./ports";

export interface SessionDisconnectHandlerDeps<Connection, Client extends ConnectedClient> {
  getLogger: () => Logger;
  sockets: SocketRegistry<Connection, Client>;
  sandbox: SandboxDisconnectMonitor;
  broadcaster: SessionBroadcaster;
}

/** Applies close and error policy independently of the underlying socket runtime. */
export class SessionDisconnectHandler<Connection, Client extends ConnectedClient> {
  constructor(private readonly deps: SessionDisconnectHandlerDeps<Connection, Client>) {}

  async handleClose(
    connection: Connection,
    code: number,
    reason: string,
    wasClean: boolean
  ): Promise<void> {
    const classified = this.deps.sockets.classify(connection);

    try {
      if (classified.kind === "sandbox") {
        if (!this.deps.sockets.clearSandboxIfMatch(connection)) {
          // A newer sandbox socket is active; this close must not schedule its termination.
          this.deps.getLogger().debug("Ignoring close for replaced sandbox socket", { code });
          return;
        }

        const sandboxStatus = this.deps.sandbox.getStatus();
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
          await this.deps.sandbox.scheduleCheck();
        }
      } else {
        const client = this.deps.sockets.removeClient(connection);
        if (client) {
          // Presence is participant-scoped, so another tab keeps the participant present.
          if (this.deps.sockets.hasParticipant(client.participantId)) {
            this.deps.broadcaster.broadcastPresence();
          } else {
            this.deps.broadcaster.broadcast({ type: "presence_leave", userId: client.userId });
          }
        }
      }
    } finally {
      // Always reciprocate the peer close, including when reconnect scheduling fails.
      this.deps.sockets.close(connection, code, reason);
    }
  }

  handleError(connection: Connection, error: Error): void {
    this.deps.getLogger().error("WebSocket error", { error });
    this.deps.sockets.close(connection, 1011, "Internal error");
  }
}
