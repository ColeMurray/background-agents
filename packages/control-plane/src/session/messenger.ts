/**
 * SessionMessenger — higher-level session messaging on top of the
 * WebSocket registry: fan-out to authenticated clients and command
 * delivery to the sandbox socket.
 */

import type { ServerMessage } from "@open-inspect/shared/types/server-messages";
import type { SandboxCommand } from "./types";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { SessionRepository } from "./repository";

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
  constructor(
    private readonly wsManager: SessionWebSocketManager,
    private readonly repository?: Pick<
      SessionRepository,
      "getCurrentViewRevision" | "readContiguousSessionViewDeltas"
    >
  ) {}

  broadcast(message: ServerMessage): void {
    this.wsManager.forEachClientSocket("authenticated_only", (ws) => {
      const view = this.wsManager.getClientViewState?.(ws) ?? null;
      if (!view || view.viewProtocol === 1 || !this.repository) {
        this.wsManager.send(ws, message);
        return;
      }

      const currentRevision = this.repository.getCurrentViewRevision();
      const records = this.repository.readContiguousSessionViewDeltas(
        view.appliedViewRevision,
        currentRevision
      );
      if (records === null) {
        this.wsManager.close(ws, 4009, "Session view requires resynchronization");
        return;
      }
      for (const record of records) {
        if (
          !this.wsManager.send(ws, {
            type: "session_delta",
            revision: record.revision,
            delta: record.delta,
          } satisfies ServerMessage)
        ) {
          this.wsManager.close(ws, 4009, "Session view delivery failed");
          return;
        }
        this.wsManager.advanceClientViewRevision(ws, record.revision);
      }

      const replacedByDelta =
        isCanonicalLegacyMessage(message) ||
        records.some((record) =>
          record.delta.operations.some((operation) => operationReplacesMessage(operation, message))
        );
      if (!replacedByDelta) {
        this.wsManager.send(ws, message);
      }
    });
  }

  sendToSandbox(command: SandboxCommand): boolean {
    const sandboxSocket = this.wsManager.getSandboxSocket();
    return sandboxSocket ? this.wsManager.send(sandboxSocket, command) : false;
  }
}

function isCanonicalLegacyMessage(message: ServerMessage): boolean {
  return (
    message.type === "artifact_created" ||
    message.type === "artifact_updated" ||
    message.type === "sandbox_status" ||
    message.type === "session_status" ||
    message.type === "session_title" ||
    message.type === "session_branch" ||
    message.type === "processing_status" ||
    message.type === "code_server_info" ||
    message.type === "ttyd_info" ||
    message.type === "tunnel_urls" ||
    message.type === "sandbox_dashboard_url"
  );
}

function operationReplacesMessage(
  operation: Extract<ServerMessage, { type: "session_delta" }>["delta"]["operations"][number],
  message: ServerMessage
): boolean {
  if (operation.type === "event_upsert" && message.type === "sandbox_event") {
    return JSON.stringify(operation.item.event) === JSON.stringify(message.event);
  }
  if (
    operation.type === "artifact_upsert" &&
    (message.type === "artifact_created" || message.type === "artifact_updated")
  ) {
    return operation.artifact.id === message.artifact.id;
  }
  if (operation.type !== "state_patch") return false;
  switch (message.type) {
    case "session_title":
      return operation.patch.title === message.title;
    case "session_status":
      return operation.patch.status === message.status;
    case "sandbox_status":
      return operation.patch.sandboxStatus === message.status;
    case "session_branch":
      return operation.patch.branchName === message.branchName;
    case "tunnel_urls":
      return JSON.stringify(operation.patch.tunnelUrls) === JSON.stringify(message.urls);
    default:
      return false;
  }
}
