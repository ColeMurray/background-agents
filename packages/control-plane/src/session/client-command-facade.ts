/**
 * Concrete client-command surface handed to the session message router.
 *
 * The router's `SessionClientCommands` port stays generic so the server stack
 * unit-tests over string connections; this class is its production
 * implementation, holding the four collaborators as constructor deps instead
 * of a closure bag in the composition root.
 */

import type { ClientInfo } from "../types";
import type {
  SessionClientCommands,
  ClientCancelPrompt,
  ClientPresence,
  ClientPrompt,
  ClientSubscribe,
  FetchHistory,
} from "./message-router";
import type { SessionEventStream, SessionHistoryPage } from "./event-stream";
import type { SessionConnectionAuthenticator } from "./connection-authenticator";
import type { SessionMessageQueue } from "./message-queue";
import type { PresenceService } from "./presence-service";
import type { PermissionId } from "@open-inspect/shared/rbac";
import type { SessionWebSocket } from "../platform-ports";
import type { ShutdownRecoveryAction } from "@open-inspect/shared/types/sandbox-shutdown";

export class SessionClientCommandFacade implements SessionClientCommands<
  SessionWebSocket,
  ClientInfo
> {
  constructor(
    private readonly authenticator: SessionConnectionAuthenticator,
    private readonly prompts: SessionMessageQueue,
    private readonly stop: () => Promise<void>,
    private readonly presence: PresenceService,
    private readonly events: SessionEventStream,
    private readonly recover?: (action: ShutdownRecoveryAction) => Promise<void>
  ) {}

  subscribe(connection: SessionWebSocket, message: ClientSubscribe): Promise<void> {
    return this.authenticator.handleSubscribe(connection, message);
  }

  submitPrompt(
    connection: SessionWebSocket,
    client: ClientInfo,
    message: ClientPrompt
  ): Promise<void> {
    return this.prompts.handlePromptMessage(connection, client, message);
  }

  cancelPrompt(connection: SessionWebSocket, message: ClientCancelPrompt): Promise<void> {
    return this.prompts.cancelQueuedPrompt(connection, message);
  }

  stopExecution(): Promise<void> {
    return this.stop();
  }

  recoverShutdown(action: ShutdownRecoveryAction): Promise<void> {
    if (!this.recover) {
      return Promise.reject(new Error("Shutdown recovery is not configured"));
    }
    return this.recover(action);
  }

  notifyTyping(): Promise<void> {
    return this.presence.handleTyping();
  }

  updatePresence(client: ClientInfo, message: ClientPresence): void {
    this.presence.updatePresence(client, message);
  }

  getHistoryPage(message: {
    cursor: NonNullable<FetchHistory["cursor"]>;
    limit?: number;
  }): SessionHistoryPage {
    return this.events.getHistoryPage(message);
  }

  authorize(
    client: ClientInfo,
    permission: PermissionId
  ): Promise<"allowed" | "denied" | "unavailable"> {
    return this.authenticator.authorizeClientCommand(client.userId, permission);
  }
}
