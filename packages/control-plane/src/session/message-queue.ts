import { generateId, hashToken } from "../auth/crypto";
import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import type {
  SessionAttachmentReference,
  ResolvedSessionAttachment,
} from "@open-inspect/shared/types/session-attachments";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
} from "@open-inspect/shared/models";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { MessageSource } from "@open-inspect/shared/types/sessions";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";
import type { ClientInfo } from "../types";
import type { SourceControlProviderName } from "../source-control";
import type { SandboxLifecycle } from "../sandbox/lifecycle/manager";
import type { ParticipantRow, PromptGitIdentity, SandboxCommand, SessionRow } from "./types";
import type { SessionCoreRepository } from "./session-core-repository";
import type { ParticipantRepository } from "./participant-repository";
import { STOP_CONFIRMATION_TIMEOUT_MS, type MessageRepository } from "./message-repository";
import {
  AttachmentClaimConflictError,
  type SessionAttachmentRepository,
} from "./session-attachment-repository";
import type { SessionMessenger } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionStatusService } from "./session-status-service";
import type { EnqueuePromptRequest } from "./enqueue-prompt-contract";
import { getAvatarUrl } from "./participant-service";
import { resolveParticipantName } from "./participant-name";
import type { AlarmScheduler, BackgroundTasks } from "../platform-ports";
import { resolveGitAuthorIdentity } from "./identity";
import { validateReasoningEffort } from "./reasoning-effort";
import {
  parseStoredSessionAttachments,
  SessionAttachmentError,
  resolveSessionAttachments,
} from "./session-attachment-resolver";

interface PromptMessageData {
  clientRequestId?: string;
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
  clientRequestId?: string;
}

interface EnqueuedPrompt {
  messageId: string;
  position: number | null;
}

export class SessionNotPromptableError extends Error {
  constructor(readonly sessionStatus: SessionRow["status"]) {
    super(`Cannot prompt a ${sessionStatus} session`);
    this.name = "SessionNotPromptableError";
  }
}

export class PromptQueueFullError extends Error {
  constructor() {
    super(`A session may have at most ${MAX_UNFINISHED_PROMPTS} unfinished prompts`);
    this.name = "PromptQueueFullError";
  }
}

export class PromptRequestConflictError extends Error {
  constructor() {
    super("clientRequestId was already used for a different prompt");
    this.name = "PromptRequestConflictError";
  }
}

export async function fingerprintWebPrompt(
  participantId: string,
  data: Pick<PromptMessageData, "content" | "model" | "reasoningEffort" | "attachments">
): Promise<string> {
  const canonicalRequest = JSON.stringify({
    participantId,
    content: data.content,
    model: data.model ?? null,
    reasoningEffort: data.reasoningEffort ?? null,
    attachmentIds: data.attachments?.map((attachment) => attachment.attachmentId) ?? [],
  });
  return hashToken(canonicalRequest);
}

export function isPromptableSessionStatus(status: SessionRow["status"]): boolean {
  switch (status) {
    case "created":
    case "active":
    case "completed":
    case "failed":
      return true;
    case "archived":
    case "cancelled":
      return false;
  }
}

function resolveParticipantGitIdentity(
  participant: ParticipantRow | null,
  scmProvider: SourceControlProviderName
): PromptGitIdentity {
  const gitAuthor = resolveGitAuthorIdentity({
    scmProvider,
    scmUserId: participant?.scm_user_id,
    scmLogin: participant?.scm_login,
    scmName: participant?.scm_name,
    scmEmail: participant?.scm_email,
  });
  return gitAuthor
    ? {
        mode: "attributed-user",
        name: gitAuthor.name,
        email: gitAuthor.email,
      }
    : { mode: "agent-only" };
}

export class SessionMessageQueue {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly log: Logger,
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: MessageRepository,
    private readonly participantRepository: ParticipantRepository,
    private readonly attachmentRepository: SessionAttachmentRepository,
    private readonly wsManager: SessionWebSocketManager,
    private readonly messenger: SessionMessenger,
    private readonly participantService: ParticipantService,
    private readonly callbackService: CallbackNotificationService,
    private readonly sessionStatus: SessionStatusService,
    private readonly projectTerminalMessage: (
      messageId: string,
      messageCreatedAt: number,
      completedAt: number
    ) => Promise<void>,
    private readonly sandboxLifecycle: SandboxLifecycle,
    private readonly sessionIndex: SessionIndexStore | null,
    private readonly scmProvider: SourceControlProviderName,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly executionTimeoutMs: number
  ) {}

  async handlePromptMessage(
    ws: WebSocket,
    client: ClientInfo,
    data: PromptMessageData
  ): Promise<void> {
    let enqueued: EnqueuedPrompt;
    try {
      this.assertPromptableSession();
      let participant = this.participantRepository.getParticipantById(client.participantId);
      participant ??= this.participantService.getByUserId(client.userId);
      if (!participant) {
        this.assertQueueCapacity();
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
        clientRequestId: data.clientRequestId,
      });
    } catch (error) {
      if (error instanceof SessionAttachmentError) {
        this.wsManager.send(ws, {
          type: "error",
          code: "INVALID_ATTACHMENTS",
          message: error.message,
          clientRequestId: data.clientRequestId,
        });
        return;
      }
      if (error instanceof SessionNotPromptableError) {
        this.wsManager.send(ws, {
          type: "error",
          code: "SESSION_NOT_PROMPTABLE",
          message: error.message,
          clientRequestId: data.clientRequestId,
        });
        return;
      }
      if (error instanceof PromptQueueFullError) {
        this.wsManager.send(ws, {
          type: "error",
          code: "PROMPT_QUEUE_FULL",
          message: error.message,
          clientRequestId: data.clientRequestId,
        });
        return;
      }
      if (error instanceof PromptRequestConflictError) {
        this.wsManager.send(ws, {
          type: "error",
          code: "PROMPT_REQUEST_CONFLICT",
          message: error.message,
          clientRequestId: data.clientRequestId,
        });
        return;
      }
      throw error;
    }

    const sessionIndex = this.sessionIndex;
    if (sessionIndex) {
      const session = this.repository.getSession();
      const sessionId = session?.session_name || session?.id;
      if (sessionId) {
        this.backgroundTasks.submit(sessionIndex.touchUpdatedAt(sessionId), {
          name: "session_index.touch_updated_at",
          context: { session_id: sessionId },
        });
      }
    }

    this.wsManager.send(ws, {
      type: "prompt_queued",
      clientRequestId: data.clientRequestId,
      messageId: enqueued.messageId,
      position: enqueued.position,
    });

    await this.processMessageQueue();
  }

  async cancelQueuedPrompt(
    ws: WebSocket,
    data: { messageId: string; clientRequestId: string }
  ): Promise<void> {
    if (!this.messageRepository.cancelPendingMessage(data.messageId)) {
      this.wsManager.send(ws, {
        type: "error",
        code: "PROMPT_NOT_CANCELLABLE",
        message: "This prompt is no longer pending and cannot be removed",
        clientRequestId: data.clientRequestId,
      });
      return;
    }

    this.wsManager.send(ws, {
      type: "prompt_cancelled",
      clientRequestId: data.clientRequestId,
      messageId: data.messageId,
    });
    this.broadcastPromptQueue();
    this.log.info("prompt.cancelled", {
      event: "prompt.cancelled",
      message_id: data.messageId,
    });

    await this.sessionStatus.reconcileAfterQueueRemoval();
  }

  async processMessageQueue(): Promise<void> {
    const currentSession = this.repository.getSession();
    if (!currentSession || !isPromptableSessionStatus(currentSession.status)) {
      return;
    }
    const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (awaitingStop) {
      if (awaitingStop.deadline <= Date.now()) {
        await this.recoverStopConfirmationTimeout();
      } else {
        await this.alarmScheduler.schedule(awaitingStop.deadline);
      }
      this.log.debug("processMessageQueue: waiting for sandbox stop confirmation");
      return;
    }
    if (this.messageRepository.getProcessingMessage()) {
      this.log.debug("processMessageQueue: already processing, returning");
      return;
    }

    const message = this.messageRepository.getNextPendingMessage();
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
      // Spawn in the background: a snapshot restore can take tens of seconds,
      // and awaiting it here holds the prompt HTTP response open past bot
      // callers' request timeouts. The message is already persisted as
      // pending and dispatches when the sandbox WebSocket connects.
      this.backgroundTasks.submit(
        this.sandboxLifecycle.spawnSandbox().catch((error) => {
          // Expected provider failures report themselves inside the lifecycle
          // manager; this catch only sees throws from before those handlers.
          // Route it through the same call so the reason is persisted as well
          // as broadcast — otherwise it survives only until the tab reloads.
          this.sandboxLifecycle.reportSandboxError(
            error instanceof Error ? error.message : "Failed to spawn sandbox"
          );
          throw error;
        }),
        {
          name: "sandbox.spawn",
          context: { message_id: message.id },
        }
      );
      return;
    }

    const author = this.participantRepository.getParticipantById(message.author_id);
    if (!author) {
      throw new Error(`Missing prompt author ${message.author_id}`);
    }
    const userMessageEvent = this.createUserMessageEvent(
      author,
      message.content,
      message.id,
      now,
      parseStoredSessionAttachments(message.attachments, () =>
        this.log.error("prompt.invalid_stored_attachments")
      )
    );
    const gitIdentity = resolveParticipantGitIdentity(author, this.scmProvider);
    const session = this.repository.getSession();
    const resolvedModel = getValidModelOrDefault(message.model || session?.model);
    const requestedEffort =
      message.reasoning_effort ??
      session?.reasoning_effort ??
      getDefaultReasoningEffort(resolvedModel);
    const resolvedEffort =
      validateReasoningEffort(resolvedModel, requestedEffort ?? undefined, this.log) ?? undefined;

    const command: SandboxCommand = {
      type: "prompt",
      messageId: message.id,
      content: message.content,
      model: resolvedModel,
      reasoningEffort: resolvedEffort,
      author: {
        userId: author?.user_id ?? "unknown",
        gitIdentity,
      },
      attachments: parseStoredSessionAttachments(message.attachments, () =>
        this.log.error("prompt.invalid_stored_attachments")
      ),
    };

    const claimed = this.messageRepository.startMessageProcessing(
      message.id,
      now,
      userMessageEvent
    );
    if (!claimed) {
      this.log.debug("processMessageQueue: prompt claim lost", { message_id: message.id });
      return;
    }

    const sent = this.wsManager.send(sandboxWs, command);

    if (!sent) {
      this.messageRepository.updateMessageToPending(message.id);
      await this.sandboxLifecycle.terminateUnresponsiveSandbox("prompt_dispatch_send_failed");
    } else {
      this.messenger.broadcast({ type: "sandbox_event", event: userMessageEvent });
      this.messenger.broadcast({ type: "processing_status", isProcessing: true });
      this.broadcastPromptQueue();
      this.sandboxLifecycle.updateLastActivity(now);

      // Execution timeout shares the DO's single alarm slot with lifecycle checks.
      const deadline = now + this.executionTimeoutMs;
      await this.alarmScheduler.schedule(deadline);

      this.backgroundTasks.submit(this.callbackService.notifyStarted(message.id), {
        name: "callback.notify_started",
        context: { message_id: message.id },
      });
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
    const processingMessage = this.messageRepository.getProcessingMessageWithCreatedAt();
    let stoppedMessageId: string | null = null;

    if (
      processingMessage &&
      this.failMessage(processingMessage, "Execution was stopped", now, "processing")
    ) {
      stoppedMessageId = processingMessage.id;
      const stopConfirmationDeadline = now + STOP_CONFIRMATION_TIMEOUT_MS;
      this.messageRepository.markMessageAwaitingStopConfirmation(
        processingMessage.id,
        stopConfirmationDeadline
      );
      await this.alarmScheduler.schedule(stopConfirmationDeadline);
      this.broadcastPromptQueue();
      this.log.info("prompt.stopped", {
        event: "prompt.stopped",
        message_id: processingMessage.id,
      });
      if (!options.suppressStatusReconcile) {
        await this.sessionStatus.reconcileAfterExecution(false);
      }
    }

    this.messenger.broadcast({ type: "processing_status", isProcessing: false });

    const sandboxWs = this.wsManager.getSandboxSocket();
    if (stoppedMessageId && (!sandboxWs || !this.wsManager.send(sandboxWs, { type: "stop" }))) {
      await this.sandboxLifecycle.terminateUnresponsiveSandbox("stop_send_failed");
    }
  }

  async recoverStopConfirmationTimeout(): Promise<void> {
    const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (!awaitingStop || awaitingStop.deadline > Date.now()) return;
    this.log.warn("Sandbox did not confirm stop before deadline", {
      event: "prompt.stop_confirmation_timeout",
      message_id: awaitingStop.id,
    });
    await this.sandboxLifecycle.terminateUnresponsiveSandbox("stop_confirmation_timeout");
  }

  async resumeAfterSandboxTermination(): Promise<void> {
    const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (awaitingStop) {
      this.messageRepository.clearMessageAwaitingStopConfirmation(awaitingStop.id);
    }
    await this.processMessageQueue();
  }

  /** Close every unfinished message synchronously; status projection happens afterwards. */
  cancelExecution(): void {
    const now = Date.now();
    for (const message of this.messageRepository.listPendingMessagesWithCreatedAt()) {
      this.failMessage(message, "Execution was cancelled before it started", now, "pending");
    }

    const processingMessage = this.messageRepository.getProcessingMessageWithCreatedAt();
    if (processingMessage) {
      this.failMessage(processingMessage, "Execution was cancelled", now, "processing");
    }

    this.messenger.broadcast({ type: "processing_status", isProcessing: false });
    this.broadcastPromptQueue();
    const sandboxWs = this.wsManager.getSandboxSocket();
    if (sandboxWs) this.wsManager.send(sandboxWs, { type: "stop" });
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
    const processingMessage = this.messageRepository.getProcessingMessageWithCreatedAt();
    if (!processingMessage) return;

    if (
      !this.failMessage(
        processingMessage,
        "Execution timed out (stuck processing)",
        now,
        "processing"
      )
    ) {
      return;
    }
    this.messenger.broadcast({ type: "processing_status", isProcessing: false });
    this.broadcastPromptQueue();
    await this.sessionStatus.reconcileAfterExecution(false);
  }

  private failMessage(
    message: { id: string; created_at: number },
    error: string,
    completedAt: number,
    expectedStatus: "pending" | "processing"
  ): boolean {
    const event: Extract<SandboxEvent, { type: "execution_complete" }> = {
      type: "execution_complete",
      messageId: message.id,
      success: false,
      error,
      sandboxId: "",
      timestamp: completedAt / 1000,
    };
    const completion = this.messageRepository.recordMessageCompletion(
      event,
      completedAt,
      expectedStatus
    );
    if (!completion) return false;

    const projection = this.projectTerminalMessage(
      completion.messageId,
      completion.messageCreatedAt,
      completion.completedAt
    )
      .catch((projectionError) => {
        this.log.error("terminal_message.projection_failed", {
          message_id: message.id,
          error: projectionError,
        });
      })
      .then(() => this.messenger.broadcast({ type: "sandbox_event", event }));
    this.backgroundTasks.submit(projection, {
      name: "terminal_message.project",
      context: { message_id: message.id },
    });
    this.backgroundTasks.submit(this.callbackService.notifyComplete(message.id, false, error), {
      name: "callback.notify_complete",
      context: { message_id: message.id },
    });
    return true;
  }

  private createUserMessageEvent(
    participant: ParticipantRow,
    content: string,
    messageId: string,
    now: number,
    attachments?: ResolvedSessionAttachment[]
  ): Extract<SandboxEvent, { type: "user_message" }> {
    return {
      type: "user_message",
      content,
      messageId,
      timestamp: now / 1000,
      author: {
        participantId: participant.id,
        userId: participant.canonical_user_id ?? participant.user_id,
        name: resolveParticipantName(participant),
        avatar: getAvatarUrl(participant.scm_login, this.scmProvider),
      },
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
    };
  }

  async enqueuePromptFromApi(
    data: EnqueuePromptRequest
  ): Promise<{ messageId: string; status: "queued" }> {
    this.assertPromptableSession();
    this.assertQueueCapacity();
    let participant = this.participantService.getByUserId(data.authorId);
    if (!participant) {
      const name = data.scmEnrichment?.name || data.authorId;
      participant = data.canonicalUserId
        ? this.participantService.create(data.authorId, name, data.canonicalUserId)
        : this.participantService.create(data.authorId, name);
    }

    if (data.canonicalUserId) {
      this.participantRepository.updateParticipantCoalesce(participant.id, {
        canonicalUserId: data.canonicalUserId,
      });
      participant = this.participantRepository.getParticipantById(participant.id) ?? {
        ...participant,
        canonical_user_id: data.canonicalUserId,
      };
    }

    if (data.scmEnrichment !== undefined) {
      const enrichment = data.scmEnrichment;
      this.participantRepository.updateParticipantCoalesce(participant.id, {
        scmName: enrichment.name,
        scmEmail: enrichment.email,
        scmLogin: enrichment.login,
        scmUserId: enrichment.userId,
        scmAccessTokenEncrypted: enrichment.accessTokenEncrypted,
        scmRefreshTokenEncrypted: enrichment.refreshTokenEncrypted,
        scmTokenExpiresAt: enrichment.tokenExpiresAt,
      });
      participant = this.participantRepository.getParticipantById(participant.id) ?? participant;
    }

    const enqueued = await this.enqueuePromptCore({
      participant,
      userId: data.authorId,
      content: data.content,
      source: data.source,
      model: data.model,
      reasoningEffort: data.reasoningEffort,
      attachments: data.attachments,
      callbackContext: data.callbackContext,
    });

    await this.processMessageQueue();

    return { messageId: enqueued.messageId, status: "queued" };
  }

  private async enqueuePromptCore(data: EnqueuePromptCoreData): Promise<EnqueuedPrompt> {
    this.assertPromptableSession();
    let requestFingerprint: string | undefined;
    if (data.clientRequestId) {
      requestFingerprint = await fingerprintWebPrompt(data.participant.id, data);
    }

    // Keep the idempotency lookup, capacity check, and insert in one synchronous
    // turn so concurrent WebSocket requests cannot race between them.
    const queueDepthBefore = this.messageRepository.getPendingOrProcessingCount();
    if (data.clientRequestId) {
      const existing = this.messageRepository.getMessageByClientRequestId(data.clientRequestId);
      if (existing) {
        if (
          existing.author_id !== data.participant.id ||
          existing.request_fingerprint !== requestFingerprint
        ) {
          this.log.warn("prompt.enqueue", {
            event: "prompt.enqueue",
            outcome: "conflict",
            source: data.source,
            queue_depth_before: queueDepthBefore,
            queue_depth_after: queueDepthBefore,
          });
          throw new PromptRequestConflictError();
        }
        this.log.info("prompt.enqueue", {
          event: "prompt.enqueue",
          outcome: "deduplicated",
          source: data.source,
          queue_depth_before: queueDepthBefore,
          queue_depth_after: queueDepthBefore,
        });
        return {
          messageId: existing.id,
          position: this.messageRepository.getUnfinishedMessagePosition(existing.id),
        };
      }
    }
    this.assertQueueCapacity(queueDepthBefore);
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
      this.messageRepository.createMessageWithAttachments(
        {
          id: messageId,
          authorId: data.participant.id,
          content: data.content,
          source: data.source,
          model: messageModel,
          reasoningEffort: messageReasoningEffort,
          attachments: attachments ? JSON.stringify(attachments) : null,
          callbackContext: data.callbackContext ? JSON.stringify(data.callbackContext) : null,
          clientRequestId: data.clientRequestId ?? null,
          requestFingerprint: requestFingerprint ?? null,
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
    this.broadcastPromptQueue();

    const position = this.messageRepository.getPendingOrProcessingCount();
    this.log.info("prompt.enqueue", {
      event: "prompt.enqueue",
      outcome: "enqueued",
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
      queue_depth_before: queueDepthBefore,
      queue_depth_after: position,
    });

    return { messageId, position };
  }

  private assertPromptableSession(): void {
    const session = this.repository.getSession();
    if (session && !isPromptableSessionStatus(session.status)) {
      throw new SessionNotPromptableError(session.status);
    }
  }

  private assertQueueCapacity(
    queueDepth = this.messageRepository.getPendingOrProcessingCount()
  ): void {
    if (queueDepth >= MAX_UNFINISHED_PROMPTS) {
      this.log.warn("prompt.enqueue", {
        event: "prompt.enqueue",
        outcome: "rejected",
        reason: "queue_full",
        queue_depth_before: queueDepth,
        queue_depth_after: queueDepth,
      });
      throw new PromptQueueFullError();
    }
  }

  broadcastPromptQueue(): void {
    this.messenger.broadcast({
      type: "prompt_queue_updated",
      promptQueue: this.messageRepository.listPromptQueue(),
    });
  }
}
