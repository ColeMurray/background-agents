import { generateId } from "../auth/crypto";
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
import type { ClientInfo } from "../types";
import type { SourceControlProviderName } from "../source-control";
import type { AlarmScheduler, SandboxLifecycle } from "../sandbox/lifecycle/manager";
import type { ParticipantRow, PromptGitIdentity, SandboxCommand, SessionRow } from "./types";
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
import type { EnqueuePromptRequest } from "./enqueue-prompt-contract";
import { getAvatarUrl } from "./participant-service";
import { resolveParticipantName } from "./participant-name";
import { resolveGitAuthorIdentity } from "./identity";
import { validateReasoningEffort } from "./reasoning-effort";
import type { TerminalMessageProjectionInput } from "./terminal-message-projection";
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

export class SessionNotPromptableError extends Error {
  constructor(readonly sessionStatus: SessionRow["status"]) {
    super(`Cannot prompt a ${sessionStatus} session`);
    this.name = "SessionNotPromptableError";
  }
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
    private readonly alarmScheduler: AlarmScheduler,
    private readonly executionTimeoutMs: number,
    private readonly recordTerminalMessage: (input: TerminalMessageProjectionInput) => Promise<void>
  ) {}

  async handlePromptMessage(
    ws: WebSocket,
    client: ClientInfo,
    data: PromptMessageData
  ): Promise<void> {
    let enqueued: EnqueuedPrompt;
    try {
      this.assertPromptableSession();
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
      if (error instanceof SessionAttachmentError) {
        this.wsManager.send(ws, {
          type: "error",
          code: "INVALID_ATTACHMENTS",
          message: error.message,
        });
        return;
      }
      if (error instanceof SessionNotPromptableError) {
        this.wsManager.send(ws, {
          type: "error",
          code: "SESSION_NOT_PROMPTABLE",
          message: error.message,
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
    const currentSession = this.repository.getSession();
    if (!currentSession || !isPromptableSessionStatus(currentSession.status)) {
      return;
    }
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
      // Spawn in the background: a snapshot restore can take tens of seconds,
      // and awaiting it here holds the prompt HTTP response open past bot
      // callers' request timeouts. The message is already persisted as
      // pending and dispatches when the sandbox WebSocket connects.
      this.ctx.waitUntil(
        this.sandboxLifecycle.spawnSandbox().catch((error) => {
          // Expected provider failures broadcast sandbox_error inside the
          // lifecycle manager; this catch only sees throws from before those
          // handlers. Surface them the same way so clients aren't left
          // watching a silent "sandbox_spawning" forever.
          this.log.error("prompt.spawn.background_error", {
            message_id: message.id,
            error: error instanceof Error ? error : String(error),
          });
          this.messenger.broadcast({
            type: "sandbox_error",
            error: error instanceof Error ? error.message : "Failed to spawn sandbox",
          });
        })
      );
      return;
    }

    this.repository.updateMessageToProcessing(message.id, now);
    this.messenger.broadcast({ type: "processing_status", isProcessing: true });
    this.sandboxLifecycle.updateLastActivity(now);

    // Execution timeout shares the DO's single alarm slot with lifecycle checks.
    const deadline = now + this.executionTimeoutMs;
    await this.alarmScheduler.scheduleAlarm(deadline);

    const author = this.repository.getParticipantById(message.author_id);
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
    const processingMessage = this.repository.getProcessingMessageWithCreatedAt();

    if (processingMessage) {
      this.failMessage(processingMessage, "Execution was stopped", now);
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
    if (sandboxWs) {
      this.wsManager.send(sandboxWs, { type: "stop" });
    }
  }

  /** Close every unfinished message synchronously; status projection happens afterwards. */
  cancelExecution(): void {
    const now = Date.now();
    const pendingMessages = this.repository.listPendingMessagesWithCreatedAt();
    for (const message of pendingMessages) {
      this.failMessage(message, "Execution was cancelled before it started", now);
    }

    const processingMessage = this.repository.getProcessingMessageWithCreatedAt();
    if (processingMessage) {
      this.failMessage(processingMessage, "Execution was cancelled", now);
    }

    this.messenger.broadcast({ type: "processing_status", isProcessing: false });
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
    const processingMessage = this.repository.getProcessingMessageWithCreatedAt();
    if (!processingMessage) return;

    const stuckError = "Execution timed out (stuck processing)";
    this.failMessage(processingMessage, stuckError, now);
    this.messenger.broadcast({ type: "processing_status", isProcessing: false });
    await this.sessionStatus.reconcileAfterExecution(false);
  }

  private failMessage(
    message: { id: string; created_at: number },
    error: string,
    completedAt: number
  ): void {
    this.repository.updateMessageCompletion(message.id, "failed", completedAt);
    const event: Extract<SandboxEvent, { type: "execution_complete" }> = {
      type: "execution_complete",
      messageId: message.id,
      success: false,
      error,
      sandboxId: "",
      timestamp: completedAt / 1000,
    };
    this.repository.upsertExecutionCompleteEvent(message.id, event, completedAt);
    this.ctx.waitUntil(
      this.recordTerminalMessage({
        messageId: message.id,
        messageCreatedAt: message.created_at,
        terminalMessageCompletedAt: completedAt,
      })
    );
    this.messenger.broadcast({ type: "sandbox_event", event });
    this.ctx.waitUntil(this.callbackService.notifyComplete(message.id, false, error));
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
        userId: participant.canonical_user_id ?? participant.user_id,
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
    this.assertPromptableSession();
    let participant = this.participantService.getByUserId(data.authorId);
    if (!participant) {
      const name = data.scmEnrichment?.name || data.authorId;
      participant = data.canonicalUserId
        ? this.participantService.create(data.authorId, name, data.canonicalUserId)
        : this.participantService.create(data.authorId, name);
    }

    if (data.canonicalUserId) {
      this.repository.updateParticipantCoalesce(participant.id, {
        canonicalUserId: data.canonicalUserId,
      });
      participant = this.repository.getParticipantById(participant.id) ?? {
        ...participant,
        canonical_user_id: data.canonicalUserId,
      };
    }

    if (data.scmEnrichment !== undefined) {
      const enrichment = data.scmEnrichment;
      this.repository.updateParticipantCoalesce(participant.id, {
        scmName: enrichment.name,
        scmEmail: enrichment.email,
        scmLogin: enrichment.login,
        scmUserId: enrichment.userId,
        scmAccessTokenEncrypted: enrichment.accessTokenEncrypted,
        scmRefreshTokenEncrypted: enrichment.refreshTokenEncrypted,
        scmTokenExpiresAt: enrichment.tokenExpiresAt,
      });
      participant = this.repository.getParticipantById(participant.id) ?? participant;
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

  private assertPromptableSession(): void {
    const session = this.repository.getSession();
    if (session && !isPromptableSessionStatus(session.status)) {
      throw new SessionNotPromptableError(session.status);
    }
  }
}
