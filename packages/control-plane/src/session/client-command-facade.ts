/**
 * Concrete client-command surface handed to the session message router.
 *
 * The router's `SessionClientCommands` port stays generic so the server stack
 * unit-tests over string connections; this class is its production
 * implementation. Browser acknowledgements and domain-error translation live
 * here; admission and execution do not depend on client sockets.
 */

import type { ClientInfo } from "../types";
import type {
  SessionClientCommands,
  ClientCancelPrompt,
  ClientPresence,
  ClientPrompt,
  ClientSubscribe,
  ClientCommandAuthorization,
  FetchHistory,
} from "./message-router";
import type { SessionEventStream, SessionHistoryPage } from "./event-stream";
import type { SessionConnectionAuthenticator } from "./connection-authenticator";
import type { SessionMessageQueue } from "./message-queue";
import type { PresenceService } from "./presence-service";
import type { SessionAction } from "@open-inspect/shared";
import type { SessionWebSocket } from "../platform-ports";
import type { ShutdownRecoveryAction } from "@open-inspect/shared/types/sandbox-shutdown";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { EnqueuedPrompt } from "./prompt-admission-types";
import {
  BudgetExhaustedError,
  HarnessModelIncompatibleError,
  PromptQueueFullError,
  PromptRequestConflictError,
  SandboxPromptBlockedError,
  SessionNotPromptableError,
  type SessionPromptAdmission,
} from "./prompt-admission";
import { SessionAttachmentError } from "./session-attachment-resolver";

export class SessionClientCommandFacade implements SessionClientCommands<
  SessionWebSocket,
  ClientInfo
> {
  constructor(
    private readonly authenticator: SessionConnectionAuthenticator,
    private readonly prompts: SessionMessageQueue,
    private readonly admission: SessionPromptAdmission,
    private readonly sockets: SessionWebSocketManager,
    private readonly stop: () => Promise<void>,
    private readonly presence: PresenceService,
    private readonly events: SessionEventStream,
    private readonly recover?: (action: ShutdownRecoveryAction) => Promise<void>
  ) {}

  subscribe(connection: SessionWebSocket, message: ClientSubscribe): Promise<void> {
    return this.authenticator.handleSubscribe(connection, message);
  }

  async submitPrompt(
    connection: SessionWebSocket,
    client: ClientInfo,
    message: ClientPrompt
  ): Promise<void> {
    let enqueued: EnqueuedPrompt;
    try {
      enqueued = await this.admission.enqueueFromWeb(client, message);
    } catch (error) {
      let code: string;
      if (error instanceof SessionAttachmentError) {
        code = "INVALID_ATTACHMENTS";
      } else if (error instanceof SessionNotPromptableError) {
        code = "SESSION_NOT_PROMPTABLE";
      } else if (error instanceof SandboxPromptBlockedError) {
        code = "SANDBOX_RECOVERY_REQUIRED";
      } else if (error instanceof PromptQueueFullError) {
        code = "PROMPT_QUEUE_FULL";
      } else if (error instanceof PromptRequestConflictError) {
        code = "PROMPT_REQUEST_CONFLICT";
      } else if (error instanceof BudgetExhaustedError) {
        code = "BUDGET_EXHAUSTED";
      } else if (error instanceof HarnessModelIncompatibleError) {
        code = "HARNESS_MODEL_INCOMPATIBLE";
      } else {
        throw error;
      }
      this.sockets.send(connection, {
        type: "error",
        code,
        message: error.message,
        clientRequestId: message.clientRequestId,
      });
      return;
    }

    this.sockets.send(connection, {
      type: "prompt_queued",
      clientRequestId: message.clientRequestId,
      messageId: enqueued.messageId,
      position: enqueued.position,
    });
    await this.prompts.processMessageQueue();
  }

  async cancelPrompt(connection: SessionWebSocket, message: ClientCancelPrompt): Promise<void> {
    const cancelled = await this.prompts.cancelQueuedPrompt(message.messageId, () => {
      this.sockets.send(connection, {
        type: "prompt_cancelled",
        clientRequestId: message.clientRequestId,
        messageId: message.messageId,
      });
    });
    if (!cancelled) {
      this.sockets.send(connection, {
        type: "error",
        code: "PROMPT_NOT_CANCELLABLE",
        message: "This prompt is no longer pending and cannot be removed",
        clientRequestId: message.clientRequestId,
      });
    }
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
    connection: SessionWebSocket,
    client: ClientInfo,
    action: SessionAction
  ): Promise<ClientCommandAuthorization> {
    return this.authenticator.authorizeClientCommand(connection, client.userId, action);
  }
}
