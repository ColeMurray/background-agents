import { generateId } from "../auth/crypto";
import { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
  type SessionAttachmentReference,
  type ResolvedSessionAttachment,
} from "@open-inspect/shared";
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
import {
  AttachmentClaimConflictError,
  type SessionAttachmentRepository,
} from "./session-attachment-repository";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { EnqueuePromptRequest } from "./services/message.service";
import { getAvatarUrl } from "./participant-service";
import { resolveParticipantName } from "./participant-name";
import {
  parseStoredSessionAttachments,
  SessionAttachmentError,
  resolveSessionAttachments,
} from "./session-attachment-resolver";

interface PromptMessageData {
  content: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: SessionAttachmentReference[];
}

interface MessageQueueDeps {
  env: Env;
  ctx: DurableObjectState;
  log: Logger;
  repository: SessionRepository;
  attachmentRepository: SessionAttachmentRepository;
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
  getDispatchBlockReason: () => string | null;
  beginDiffCapture: (triggerMessageId: string) => Promise<void>;
}

interface StopExecutionOptions {
  suppressStatusReconcile?: boolean;
}

interface EnqueuePromptCoreData {
  participant: ParticipantRow;
  userId: string;
  content: string;
  source: MessageSource;
  model?: string;
  reasoningEffort?: string;
  attachments?: SessionAttachmentReference[];
  callbackContext?: Record<string, unknown>;
}

interface EnqueuedPrompt {
  messageId: string;
  position: number;
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

    let enqueued: EnqueuedPrompt;
    try {
      let participant = this.deps.participantService.getByUserId(client.userId);
      if (!participant) {
        participant = this.deps.participantService.create(client.userId, client.name);
      }
      enqueued = await this.enqueuePromptCore({
        participant,
        userId: client.userId,
        content: data.content,
        source: "web",
        model: data.model,
        reasoningEffort: data.reasoningEffort,
        attachments: data.attachments,
      });
    } catch (error) {
      if (!(error instanceof SessionAttachmentError)) throw error;
      this.deps.wsManager.send(ws, {
        type: "error",
        code: "INVALID_ATTACHMENTS",
        message: error.message,
      });
      return;
    }

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
      messageId: enqueued.messageId,
      position: enqueued.position,
    });

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

    const dispatchBlockReason = this.deps.getDispatchBlockReason();
    if (dispatchBlockReason) {
      this.deps.log.info("prompt.dispatch", {
        event: "prompt.dispatch",
        message_id: message.id,
        outcome: "deferred",
        reason: dispatchBlockReason,
      });
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
      attachments: parseStoredSessionAttachments(message.attachments, () =>
        this.deps.log.error("prompt.invalid_stored_attachments")
      ),
    };

    const sent = this.deps.wsManager.send(sandboxWs, command);

    if (sent) {
      this.deps.ctx.waitUntil(
        this.deps.callbackService.notifyStarted(message.id).catch((error) => {
          this.deps.log.error("callback.started.background_error", {
            message_id: message.id,
            error,
          });
        })
      );
    }

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
      const sandboxWs = this.deps.wsManager.getSandboxSocket();
      if (sandboxWs) {
        // WebSocket commands are ordered. Stop the mutating prompt before the
        // capture command that beginDiffCapture sends.
        this.deps.wsManager.send(sandboxWs, { type: "stop" });
      }
      this.deps.repository.updateMessageCompletion(processingMessage.id, "failed", now);
      this.deps.log.info("prompt.stopped", {
        event: "prompt.stopped",
        message_id: processingMessage.id,
      });

      const stopError = "Execution was stopped";
      const syntheticExecutionComplete: Extract<SandboxEvent, { type: "execution_complete" }> = {
        type: "execution_complete",
        messageId: processingMessage.id,
        success: false,
        error: stopError,
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
        this.deps.callbackService.notifyComplete(processingMessage.id, false, stopError)
      );

      await this.deps.beginDiffCapture(processingMessage.id);
      if (!options.suppressStatusReconcile) {
        await this.deps.reconcileSessionStatusAfterExecution(false);
      }
    }

    this.deps.broadcast({ type: "processing_status", isProcessing: false });
  }

  /**
   * Fail a stuck processing message (defense-in-depth for execution timeout).
   *
   * Stops the mutating prompt before capturing its terminal checkout state. It
   * does not call processMessageQueue(); the existing capture barrier and
   * lifecycle flow continue to own later dispatch.
   */
  async failStuckProcessingMessage(): Promise<void> {
    const now = Date.now();
    const processingMessage = this.deps.repository.getProcessingMessage();
    if (!processingMessage) return;

    this.deps.repository.updateMessageCompletion(processingMessage.id, "failed", now);

    const stuckError = "Execution timed out (stuck processing)";
    const syntheticEvent: Extract<SandboxEvent, { type: "execution_complete" }> = {
      type: "execution_complete",
      messageId: processingMessage.id,
      success: false,
      error: stuckError,
      sandboxId: "",
      timestamp: now / 1000,
    };
    this.deps.repository.upsertExecutionCompleteEvent(processingMessage.id, syntheticEvent, now);
    this.deps.broadcast({ type: "sandbox_event", event: syntheticEvent });
    this.deps.broadcast({ type: "processing_status", isProcessing: false });
    this.deps.ctx.waitUntil(
      this.deps.callbackService.notifyComplete(processingMessage.id, false, stuckError)
    );
    const sandboxWs = this.deps.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.deps.wsManager.send(sandboxWs, { type: "stop" });
    }
    await this.deps.beginDiffCapture(processingMessage.id);
    await this.deps.reconcileSessionStatusAfterExecution(false);
  }

  writeUserMessageEvent(
    participant: ParticipantRow,
    content: string,
    messageId: string,
    now: number,
    attachments?: ResolvedSessionAttachment[]
  ): void {
    // Metadata only — base64 payloads would bloat the events table and every
    // broadcast, and DO SQLite rows cap at 2 MB.
    const userMessageEvent: SandboxEvent = {
      type: "user_message",
      content,
      messageId,
      timestamp: now / 1000,
      author: {
        participantId: participant.id,
        name: resolveParticipantName(participant),
        avatar: getAvatarUrl(participant.scm_login, this.deps.scmProvider),
      },
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
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

  async enqueuePromptFromApi(
    data: EnqueuePromptRequest
  ): Promise<{ messageId: string; status: "queued" }> {
    let participant = this.deps.participantService.getByUserId(data.authorId);
    if (!participant) {
      participant = this.deps.participantService.create(
        data.authorId,
        data.authorDisplayName || data.authorId
      );
    }

    // COALESCE update: populate identity fields on non-owner participants
    const hasEnrichment =
      data.authorDisplayName ||
      data.authorEmail ||
      data.authorLogin ||
      data.scmUserId ||
      data.scmAccessTokenEncrypted;
    if (hasEnrichment) {
      this.deps.repository.updateParticipantCoalesce(participant.id, {
        scmName: data.authorDisplayName ?? null,
        scmEmail: data.authorEmail ?? null,
        scmLogin: data.authorLogin ?? null,
        scmUserId: data.scmUserId ?? null,
        scmAccessTokenEncrypted: data.scmAccessTokenEncrypted ?? null,
        scmRefreshTokenEncrypted: data.scmRefreshTokenEncrypted ?? null,
        scmTokenExpiresAt: data.scmTokenExpiresAt ?? null,
      });
      participant = this.deps.repository.getParticipantById(participant.id) ?? participant;
    }

    const enqueued = await this.enqueuePromptCore({
      participant,
      userId: data.authorId,
      content: data.content,
      source: data.source as MessageSource,
      model: data.model,
      reasoningEffort: data.reasoningEffort,
      attachments: data.attachments,
      callbackContext: data.callbackContext,
    });

    await this.processMessageQueue();

    return { messageId: enqueued.messageId, status: "queued" };
  }

  private async enqueuePromptCore(data: EnqueuePromptCoreData): Promise<EnqueuedPrompt> {
    const resolvedAttachments = resolveSessionAttachments(
      data.attachments,
      this.deps.attachmentRepository
    );
    const attachments = resolvedAttachments?.attachments;
    const messageId = generateId();
    const now = Date.now();

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

    try {
      this.deps.repository.createMessageWithAttachments(
        {
          id: messageId,
          authorId: data.participant.id,
          content: data.content,
          source: data.source,
          model: messageModel,
          reasoningEffort: messageReasoningEffort,
          attachments: attachments ? JSON.stringify(attachments) : null,
          callbackContext: data.callbackContext ? JSON.stringify(data.callbackContext) : null,
          status: "pending",
          createdAt: now,
        },
        resolvedAttachments?.attachmentIds ?? []
      );
    } catch (error) {
      if (error instanceof AttachmentClaimConflictError) {
        throw new SessionAttachmentError(
          "One or more attachments are missing, expired, or already used"
        );
      }
      throw error;
    }

    await this.deps.setSessionStatus("active");
    this.writeUserMessageEvent(data.participant, data.content, messageId, now, attachments);

    const position = this.deps.repository.getPendingOrProcessingCount();
    this.deps.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      message_id: messageId,
      source: data.source,
      author_id: data.participant.id,
      user_id: data.userId,
      model: messageModel,
      reasoning_effort: messageReasoningEffort,
      content_length: data.content.length,
      has_attachments: !!attachments?.length,
      attachments_count: attachments?.length ?? 0,
      has_callback_context: !!data.callbackContext,
      queue_position: position,
    });

    return { messageId, position };
  }
}
