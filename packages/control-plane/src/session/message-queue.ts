import { generateId } from "../auth/crypto";
import { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
} from "../utils/models";
import type {
  ClientInfo,
  Env,
  MessageSource,
  SandboxEvent,
  ServerMessage,
  SessionStatus,
} from "../types";
import type { SourceControlProviderName } from "../source-control";
import type { SessionRow, ParticipantRow, SandboxCommand } from "./types";
import type { SessionRepository } from "./repository";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import { getAvatarUrl } from "./participant-service";

interface PromptMessageData {
  content: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: Array<{ type: string; name: string; url?: string; content?: string }>;
}

interface MessageQueueDeps {
  env: Env;
  ctx: DurableObjectState;
  log: Logger;
  repository: SessionRepository;
  wsManager: SessionWebSocketManager;
  participantService: ParticipantService;
  callbackService: CallbackNotificationService;
  scmProvider: SourceControlProviderName;
  getClientInfo: (ws: WebSocket) => ClientInfo | null;
  validateReasoningEffort: (model: string, effort: string | undefined) => string | null;
  getSession: () => SessionRow | null;
  updateLastActivity: (timestamp: number) => void;
  spawnSandbox: () => Promise<void>;
  broadcast: (message: ServerMessage) => void;
  setSessionStatus: (status: SessionStatus) => Promise<void>;
  reconcileSessionStatusAfterExecution: (success: boolean) => Promise<void>;
  scheduleExecutionTimeout?: (startedAtMs: number) => Promise<void>;
}

interface StopExecutionOptions {
  suppressStatusReconcile?: boolean;
}

export class SessionMessageQueue {
  constructor(private readonly deps: MessageQueueDeps) {}

  async handlePromptMessage(ws: WebSocket, data: PromptMessageData): Promise<void> {
    const client = this.deps.getClientInfo(ws);
    if (!client) {
      this.deps.wsManager.send(ws, {
        type: "error",
        code: "NOT_SUBSCRIBED",
        message: "Must subscribe first",
      });
      return;
    }

    const messageId = generateId();
    const now = Date.now();

    let participant = this.deps.participantService.getByUserId(client.userId);
    if (!participant) {
      participant = this.deps.participantService.create(client.userId, client.name);
    }

    let messageModel: string | null = null;
    if (data.model) {
      if (isValidModel(data.model)) {
        messageModel = data.model;
      } else {
        this.deps.log.warn("Invalid message model, ignoring override", { model: data.model });
      }
    }

    const effectiveModelForEffort = messageModel || this.deps.getSession()?.model || DEFAULT_MODEL;
    const messageReasoningEffort = this.deps.validateReasoningEffort(
      effectiveModelForEffort,
      data.reasoningEffort
    );

    this.deps.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: "web",
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: data.attachments ? JSON.stringify(data.attachments) : null,
      status: "pending",
      createdAt: now,
    });

    await this.deps.setSessionStatus("active");

    this.writeUserMessageEvent(participant, data.content, messageId, now);

    const position = this.deps.repository.getPendingOrProcessingCount();

    this.deps.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: "web",
      author_id: participant.id,
      user_id: client.userId,
      model: messageModel,
      reasoning_effort: messageReasoningEffort,
      content_length: data.content.length,
      has_attachments: !!data.attachments?.length,
      attachments_count: data.attachments?.length ?? 0,
      queue_position: position,
    });

    if (this.deps.env.DB) {
      const store = new SessionIndexStore(this.deps.env.DB);
      const session = this.deps.getSession();
      const sessionId = session?.session_name || session?.id;
      if (sessionId) {
        this.deps.ctx.waitUntil(
          store.touchUpdatedAt(sessionId).catch((error) => {
            this.deps.log.error("session_index.touch_updated_at.background_error", {
              session_id: sessionId,
              error,
            });
          })
        );
      }
    }

    this.deps.wsManager.send(ws, {
      type: "prompt_queued",
      messageId,
      position,
    } as ServerMessage);

    await this.processMessageQueue();
  }

  async processMessageQueue(): Promise<void> {
    if (this.deps.repository.getProcessingMessage()) {
      this.deps.log.debug("processMessageQueue: already processing, returning");
      return;
    }

    const message = this.deps.repository.getNextPendingMessage();
    if (!message) {
      return;
    }
    const now = Date.now();

    const sandboxWs = this.deps.wsManager.getSandboxSocket();
    if (!sandboxWs) {
      this.deps.log.info("prompt.dispatch", {
        event: "prompt.dispatch",
        message_id: message.id,
        outcome: "deferred",
        reason: "no_sandbox",
      });
      this.deps.broadcast({ type: "sandbox_spawning" });
      await this.deps.spawnSandbox();
      return;
    }

    this.deps.repository.updateMessageToProcessing(message.id, now);
    this.deps.broadcast({ type: "processing_status", isProcessing: true });
    this.deps.updateLastActivity(now);

    if (this.deps.scheduleExecutionTimeout) {
      await this.deps.scheduleExecutionTimeout(now);
    }

    const author = this.deps.repository.getParticipantById(message.author_id);
    const session = this.deps.getSession();
    const resolvedModel = getValidModelOrDefault(message.model || session?.model);
    const resolvedEffort =
      message.reasoning_effort ??
      session?.reasoning_effort ??
      getDefaultReasoningEffort(resolvedModel);

    const command: SandboxCommand = {
      type: "prompt",
      messageId: message.id,
      content: message.content,
      model: resolvedModel,
      reasoningEffort: resolvedEffort,
      author: {
        userId: author?.user_id ?? "unknown",
        scmName: author?.scm_name ?? null,
        scmEmail: author?.scm_email ?? null,
      },
      attachments: message.attachments ? JSON.parse(message.attachments) : undefined,
    };

    const sent = this.deps.wsManager.send(sandboxWs, command);

    this.deps.log.info("prompt.dispatch", {
      event: "prompt.dispatch",
      message_id: message.id,
      outcome: sent ? "sent" : "send_failed",
      model: resolvedModel,
      reasoning_effort: resolvedEffort,
      author_id: message.author_id,
      user_id: author?.user_id ?? "unknown",
      source: message.source,
      has_sandbox_ws: true,
      sandbox_ready_state: sandboxWs.readyState,
      queue_wait_ms: now - message.created_at,
      has_attachments: !!message.attachments,
    });
  }

  async stopExecution(options: StopExecutionOptions = {}): Promise<void> {
    const now = Date.now();
    const processingMessage = this.deps.repository.getProcessingMessage();

    if (processingMessage) {
      this.deps.repository.updateMessageCompletion(processingMessage.id, "failed", now);
      this.deps.log.info("prompt.stopped", {
        event: "prompt.stopped",
        message_id: processingMessage.id,
      });

      const syntheticExecutionComplete: Extract<SandboxEvent, { type: "execution_complete" }> = {
        type: "execution_complete",
        messageId: processingMessage.id,
        success: false,
        sandboxId: "",
        timestamp: now / 1000,
      };
      this.deps.repository.upsertExecutionCompleteEvent(
        processingMessage.id,
        syntheticExecutionComplete,
        now
      );

      this.deps.broadcast({
        type: "sandbox_event",
        event: syntheticExecutionComplete,
      });

      this.deps.ctx.waitUntil(
        this.deps.callbackService.notifyComplete(processingMessage.id, false)
      );

      if (!options.suppressStatusReconcile) {
        await this.deps.reconcileSessionStatusAfterExecution(false);
      }
    }

    this.deps.broadcast({ type: "processing_status", isProcessing: false });

    const sandboxWs = this.deps.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.deps.wsManager.send(sandboxWs, { type: "stop" });
    }
  }

  /**
   * Fail a stuck processing message (defense-in-depth for execution timeout).
   *
   * Only marks the message as failed and broadcasts — does NOT send a stop command
   * to the sandbox or call processMessageQueue(). This avoids races where a new
   * prompt could be dispatched to a sandbox being shut down.
   */
  async failStuckProcessingMessage(): Promise<void> {
    const now = Date.now();
    const processingMessage = this.deps.repository.getProcessingMessage();
    if (!processingMessage) return;

    this.deps.repository.updateMessageCompletion(processingMessage.id, "failed", now);

    const syntheticEvent: Extract<SandboxEvent, { type: "execution_complete" }> = {
      type: "execution_complete",
      messageId: processingMessage.id,
      success: false,
      sandboxId: "",
      timestamp: now / 1000,
    };
    this.deps.repository.upsertExecutionCompleteEvent(processingMessage.id, syntheticEvent, now);
    this.deps.broadcast({ type: "sandbox_event", event: syntheticEvent });
    this.deps.broadcast({ type: "processing_status", isProcessing: false });
    this.deps.ctx.waitUntil(this.deps.callbackService.notifyComplete(processingMessage.id, false));
    await this.deps.reconcileSessionStatusAfterExecution(false);
  }

  writeUserMessageEvent(
    participant: ParticipantRow,
    content: string,
    messageId: string,
    now: number
  ): void {
    const userMessageEvent: SandboxEvent = {
      type: "user_message",
      content,
      messageId,
      timestamp: now / 1000,
      author: {
        participantId: participant.id,
        name: participant.scm_name || participant.scm_login || participant.user_id,
        avatar: getAvatarUrl(participant.scm_login, this.deps.scmProvider),
      },
    };
    this.deps.repository.createEvent({
      id: generateId(),
      type: "user_message",
      data: JSON.stringify(userMessageEvent),
      messageId,
      createdAt: now,
    });
    this.deps.broadcast({ type: "sandbox_event", event: userMessageEvent });
  }

  async enqueuePromptFromApi(data: {
    content: string;
    authorId: string;
    source: string;
    model?: string;
    reasoningEffort?: string;
    attachments?: Array<{ type: string; name: string; url?: string }>;
    callbackContext?: Record<string, unknown>;
  }): Promise<{ messageId: string; status: "queued" }> {
    let participant = this.deps.participantService.getByUserId(data.authorId);
    if (!participant) {
      participant = this.deps.participantService.create(data.authorId, data.authorId);
    }

    const messageId = generateId();
    const now = Date.now();

    let messageModel: string | null = null;
    if (data.model) {
      if (isValidModel(data.model)) {
        messageModel = data.model;
      } else {
        this.deps.log.warn("Invalid message model in enqueue, ignoring", { model: data.model });
      }
    }

    const effectiveModelForEffort = messageModel || this.deps.getSession()?.model || DEFAULT_MODEL;
    const messageReasoningEffort = this.deps.validateReasoningEffort(
      effectiveModelForEffort,
      data.reasoningEffort
    );

    this.deps.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: data.source as MessageSource,
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: data.attachments ? JSON.stringify(data.attachments) : null,
      callbackContext: data.callbackContext ? JSON.stringify(data.callbackContext) : null,
      status: "pending",
      createdAt: now,
    });

    await this.deps.setSessionStatus("active");

    this.writeUserMessageEvent(participant, data.content, messageId, now);

    const queuePosition = this.deps.repository.getPendingOrProcessingCount();

    this.deps.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: data.source,
      author_id: participant.id,
      user_id: data.authorId,
      model: messageModel,
      reasoning_effort: messageReasoningEffort,
      content_length: data.content.length,
      has_attachments: !!data.attachments?.length,
      attachments_count: data.attachments?.length ?? 0,
      has_callback_context: !!data.callbackContext,
      queue_position: queuePosition,
    });

    await this.processMessageQueue();

    return { messageId, status: "queued" };
  }
}
