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
  Attachment,
  AttachmentMeta,
  ClientInfo,
  Env,
  MessageSource,
  SandboxEvent,
  ServerMessage,
  SessionStatus,
} from "../types";
import type { SourceControlProviderName } from "../source-control";
import type { SessionRow, ParticipantRow, SandboxCommand, StoredAttachment } from "./types";
import type { SessionRepository } from "./repository";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import { getAvatarUrl } from "./participant-service";

interface PromptMessageData {
  content: string;
  model?: string;
  reasoningEffort?: string;
  attachments?: Array<{ type: string; name: string; url?: string; content?: string; mimeType?: string }>;
}

/** Strip file content from attachments, keeping only metadata for storage/events. */
function toAttachmentMeta(
  attachments: PromptMessageData["attachments"]
): AttachmentMeta[] | undefined {
  if (!attachments?.length) return undefined;
  return attachments.map(({ type, name, mimeType }) => ({
    type: type as AttachmentMeta["type"],
    name,
    mimeType,
  }));
}

/**
 * Decode a base64 data URL (e.g. "data:image/png;base64,iVBOR...") into raw bytes.
 * Returns null if the string is not a valid data URL.
 */
function decodeDataUrl(dataUrl: string): Uint8Array | null {
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/s);
  if (!match) return null;
  const binaryString = atob(match[1]);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

/**
 * Upload attachments to R2 and return StoredAttachment metadata.
 * Falls back to returning undefined (caller stores raw content in SQLite) when R2 is unavailable.
 */
async function uploadAttachmentsToR2(
  r2: R2Bucket,
  attachments: NonNullable<PromptMessageData["attachments"]>,
  log: Logger
): Promise<StoredAttachment[]> {
  const stored: StoredAttachment[] = [];
  for (const att of attachments) {
    if (!att.content) continue;
    const bytes = decodeDataUrl(att.content);
    if (!bytes) {
      log.warn("attachment.upload.invalid_data_url", { name: att.name });
      continue;
    }
    const r2Key = `${crypto.randomUUID()}-${att.name}`;
    await r2.put(r2Key, bytes, {
      httpMetadata: att.mimeType ? { contentType: att.mimeType } : undefined,
    });
    stored.push({
      type: att.type as StoredAttachment["type"],
      name: att.name,
      mimeType: att.mimeType,
      r2Key,
    });
  }
  return stored;
}

/**
 * Fetch stored attachments from R2 and reconstruct full Attachment objects with data URL content.
 */
async function fetchAttachmentsFromR2(
  r2: R2Bucket,
  stored: StoredAttachment[],
  log: Logger
): Promise<Attachment[]> {
  const attachments: Attachment[] = [];
  for (const meta of stored) {
    const obj = await r2.get(meta.r2Key);
    if (!obj) {
      log.warn("attachment.fetch.not_found", { r2Key: meta.r2Key, name: meta.name });
      continue;
    }
    const bytes = new Uint8Array(await obj.arrayBuffer());
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const b64 = btoa(binary);
    const mime = meta.mimeType || "application/octet-stream";
    attachments.push({
      type: meta.type,
      name: meta.name,
      mimeType: meta.mimeType,
      content: `data:${mime};base64,${b64}`,
    });
  }
  return attachments;
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

    const attachmentMeta = toAttachmentMeta(data.attachments);

    // Upload file content to R2 (falls back to storing raw content in SQLite if R2 unavailable)
    let storedAttachments: string | null = null;
    const r2 = this.deps.env.ATTACHMENTS;
    if (data.attachments?.length && r2) {
      const stored = await uploadAttachmentsToR2(r2, data.attachments, this.deps.log);
      storedAttachments = stored.length > 0 ? JSON.stringify(stored) : null;
    } else if (attachmentMeta) {
      // No R2 — store metadata-only (content lost after this point)
      storedAttachments = JSON.stringify(attachmentMeta);
    }

    this.deps.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: "web",
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: storedAttachments,
      status: "pending",
      createdAt: now,
    });

    await this.deps.setSessionStatus("active");

    this.writeUserMessageEvent(participant, data.content, messageId, now, attachmentMeta);

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

    // Reconstruct full attachments from R2 (StoredAttachment[]) or use as-is (legacy metadata)
    let attachments: Attachment[] | undefined;
    if (message.attachments) {
      const parsed = JSON.parse(message.attachments);
      const r2 = this.deps.env.ATTACHMENTS;
      if (r2 && parsed.length > 0 && parsed[0].r2Key) {
        attachments = await fetchAttachmentsFromR2(r2, parsed as StoredAttachment[], this.deps.log);
      } else {
        attachments = parsed;
      }
    }

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
      attachments,
    };

    this.deps.log.info("prompt.scm_author", {
      message_id: message.id,
      author_user_id: author?.user_id ?? "unknown",
      scm_name: author?.scm_name ?? null,
      scm_email: author?.scm_email ?? null,
      has_scm_identity: Boolean(author?.scm_name || author?.scm_email),
    });

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
    now: number,
    attachments?: AttachmentMeta[]
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
      ...(attachments?.length ? { attachments } : {}),
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
    attachments?: Array<{ type: string; name: string; url?: string; content?: string; mimeType?: string }>;
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

    const attachmentMeta = toAttachmentMeta(data.attachments);

    let storedAttachments: string | null = null;
    const r2 = this.deps.env.ATTACHMENTS;
    if (data.attachments?.length && r2) {
      const stored = await uploadAttachmentsToR2(r2, data.attachments, this.deps.log);
      storedAttachments = stored.length > 0 ? JSON.stringify(stored) : null;
    } else if (attachmentMeta) {
      storedAttachments = JSON.stringify(attachmentMeta);
    }

    this.deps.repository.createMessage({
      id: messageId,
      authorId: participant.id,
      content: data.content,
      source: data.source as MessageSource,
      model: messageModel,
      reasoningEffort: messageReasoningEffort,
      attachments: storedAttachments,
      callbackContext: data.callbackContext ? JSON.stringify(data.callbackContext) : null,
      status: "pending",
      createdAt: now,
    });

    await this.deps.setSessionStatus("active");

    this.writeUserMessageEvent(participant, data.content, messageId, now, attachmentMeta);

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
