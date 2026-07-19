import { generateId } from "../auth/crypto";
import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
  type SessionAttachmentReference,
  type ResolvedSessionAttachment,
} from "@open-inspect/shared";
import type { ClientInfo, MessageSource, SandboxEvent } from "../types";
import type { SourceControlProviderName } from "../source-control";
import type { SandboxLifecycle } from "../sandbox/lifecycle/manager";
import type { ParticipantRow, SandboxCommand } from "./types";
import type { SessionRepository } from "./repository";
import {
  AttachmentClaimConflictError,
  type SessionAttachmentRepository,
} from "./session-attachment-repository";
import type { SessionMessenger } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionStatusService } from "./session-status-service";
import type { EnqueuePromptRequest } from "./services/message.service";
import { getAvatarUrl } from "./participant-service";
import { resolveParticipantName } from "./participant-name";
import { validateReasoningEffort } from "./reasoning-effort";
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
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly log: Logger,
    private readonly repository: SessionRepository,
    private readonly attachmentRepository: SessionAttachmentRepository,
    private readonly wsManager: SessionWebSocketManager,
    private readonly messenger: SessionMessenger,
    private readonly participantService: ParticipantService,
    private readonly callbackService: CallbackNotificationService,
    private readonly sessionStatus: SessionStatusService,
    private readonly sandboxLifecycle: SandboxLifecycle,
    private readonly sessionIndex: SessionIndexStore | null,
    private readonly scmProvider: SourceControlProviderName,
    private readonly executionTimeoutMs: number
  ) {}

  async handlePromptMessage(
    ws: WebSocket,
    client: ClientInfo,
    data: PromptMessageData
  ): Promise<void> {
    let enqueued: EnqueuedPrompt;
    try {
      let participant = this.participantService.getByUserId(client.userId);
      if (!participant) {
        participant = this.participantService.create(client.userId, client.name);
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
      this.wsManager.send(ws, {
        type: "error",
        code: "INVALID_ATTACHMENTS",
        message: error.message,
      });
      return;
    }

    const sessionIndex = this.sessionIndex;
    if (sessionIndex) {
      const session = this.repository.getSession();
      const sessionId = session?.session_name || session?.id;
      if (sessionId) {
        this.ctx.waitUntil(
          sessionIndex.touchUpdatedAt(sessionId).catch((error) => {
            this.log.error("session_index.touch_updated_at.background_error", {
              session_id: sessionId,
              error,
            });
          })
        );
      }
    }

    this.wsManager.send(ws, {
      type: "prompt_queued",
      messageId: enqueued.messageId,
      position: enqueued.position,
    });

    await this.processMessageQueue();
  }

  async processMessageQueue(): Promise<void> {
    if (this.repository.getProcessingMessage()) {
      this.log.debug("processMessageQueue: already processing, returning");
      return;
    }

    const message = this.repository.getNextPendingMessage();
    if (!message) {
      return;
    }
    const now = Date.now();

    const sandboxWs = this.wsManager.getSandboxSocket();
    if (!sandboxWs) {
      this.log.info("prompt.dispatch", {
        event: "prompt.dispatch",
        message_id: message.id,
        outcome: "deferred",
        reason: "no_sandbox",
      });
      this.messenger.broadcast({ type: "sandbox_spawning" });
      await this.sandboxLifecycle.spawnSandbox();
      return;
    }

    this.repository.updateMessageToProcessing(message.id, now);
    this.messenger.broadcast({ type: "processing_status", isProcessing: true });
    this.sandboxLifecycle.updateLastActivity(now);

    // Execution timeout shares the DO's single alarm slot with inactivity
    // checks — the earlier deadline always wins.
    const deadline = now + this.executionTimeoutMs;
    const currentAlarm = await this.ctx.storage.getAlarm();
    if (!currentAlarm || deadline < currentAlarm) {
      await this.ctx.storage.setAlarm(deadline);
    }

    const author = this.repository.getParticipantById(message.author_id);
    const session = this.repository.getSession();
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
        this.log.error("prompt.invalid_stored_attachments")
      ),
    };

    const sent = this.wsManager.send(sandboxWs, command);

    if (sent) {
      this.ctx.waitUntil(
        this.callbackService.notifyStarted(message.id).catch((error) => {
          this.log.error("callback.started.background_error", {
            message_id: message.id,
            error,
          });
        })
      );
    }

    this.log.info("prompt.dispatch", {
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
    const processingMessage = this.repository.getProcessingMessage();

    if (processingMessage) {
      this.repository.updateMessageCompletion(processingMessage.id, "failed", now);
      this.log.info("prompt.stopped", {
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
      this.repository.upsertExecutionCompleteEvent(
        processingMessage.id,
        syntheticExecutionComplete,
        now
      );

      this.messenger.broadcast({
        type: "sandbox_event",
        event: syntheticExecutionComplete,
      });

      this.ctx.waitUntil(
        this.callbackService.notifyComplete(processingMessage.id, false, stopError)
      );

      if (!options.suppressStatusReconcile) {
        await this.sessionStatus.reconcileAfterExecution(false);
      }
    }

    this.messenger.broadcast({ type: "processing_status", isProcessing: false });

    const sandboxWs = this.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.wsManager.send(sandboxWs, { type: "stop" });
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
    const processingMessage = this.repository.getProcessingMessage();
    if (!processingMessage) return;

    this.repository.updateMessageCompletion(processingMessage.id, "failed", now);

    const stuckError = "Execution timed out (stuck processing)";
    const syntheticEvent: Extract<SandboxEvent, { type: "execution_complete" }> = {
      type: "execution_complete",
      messageId: processingMessage.id,
      success: false,
      error: stuckError,
      sandboxId: "",
      timestamp: now / 1000,
    };
    this.repository.upsertExecutionCompleteEvent(processingMessage.id, syntheticEvent, now);
    this.messenger.broadcast({ type: "sandbox_event", event: syntheticEvent });
    this.messenger.broadcast({ type: "processing_status", isProcessing: false });
    this.ctx.waitUntil(
      this.callbackService.notifyComplete(processingMessage.id, false, stuckError)
    );
    await this.sessionStatus.reconcileAfterExecution(false);
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
        avatar: getAvatarUrl(participant.scm_login, this.scmProvider),
      },
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
    this.repository.createEvent({
      id: generateId(),
      type: "user_message",
      data: JSON.stringify(userMessageEvent),
      messageId,
      createdAt: now,
    });
    this.messenger.broadcast({ type: "sandbox_event", event: userMessageEvent });
  }

  async enqueuePromptFromApi(
    data: EnqueuePromptRequest
  ): Promise<{ messageId: string; status: "queued" }> {
    let participant = this.participantService.getByUserId(data.authorId);
    if (!participant) {
      participant = this.participantService.create(
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
      this.repository.updateParticipantCoalesce(participant.id, {
        scmName: data.authorDisplayName ?? null,
        scmEmail: data.authorEmail ?? null,
        scmLogin: data.authorLogin ?? null,
        scmUserId: data.scmUserId ?? null,
        scmAccessTokenEncrypted: data.scmAccessTokenEncrypted ?? null,
        scmRefreshTokenEncrypted: data.scmRefreshTokenEncrypted ?? null,
        scmTokenExpiresAt: data.scmTokenExpiresAt ?? null,
      });
      participant = this.repository.getParticipantById(participant.id) ?? participant;
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
      this.attachmentRepository
    );
    const attachments = resolvedAttachments?.attachments;
    const messageId = generateId();
    const now = Date.now();

    let messageModel: string | null = null;
    if (data.model) {
      if (isValidModel(data.model)) {
        messageModel = data.model;
      } else {
        this.log.warn("Invalid message model, ignoring override", { model: data.model });
      }
    }

    const effectiveModelForEffort =
      messageModel || this.repository.getSession()?.model || DEFAULT_MODEL;
    const messageReasoningEffort = validateReasoningEffort(
      effectiveModelForEffort,
      data.reasoningEffort,
      this.log
    );

    try {
      this.repository.createMessageWithAttachments(
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

    await this.sessionStatus.transition("active");
    this.writeUserMessageEvent(data.participant, data.content, messageId, now, attachments);

    const position = this.repository.getPendingOrProcessingCount();
    this.log.info("prompt.enqueue", {
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
