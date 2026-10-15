import {
  checkHarnessPromptCompatibility,
  getHarnessCapabilities,
  getValidHarnessOrDefault,
} from "@open-inspect/shared/harnesses";
import { DEFAULT_MODEL, isValidModel } from "@open-inspect/shared/models";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";
import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import { generateId, hashToken } from "../auth/crypto";
import type { SessionIndexStore } from "../db/session-index";
import { inheritReasoningEffort } from "../harness-admission";
import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";
import type { ClientInfo } from "../types";
import type { EnqueuePromptRequest } from "./enqueue-prompt-contract";
import type {
  EnqueuedPrompt,
  EnqueuePromptCoreData,
  PromptMessageData,
} from "./prompt-admission-types";
import type { MessageRepository } from "./message-repository";
import type { SessionMessenger } from "./messenger";
import type { ParticipantRepository } from "./participant-repository";
import type { ParticipantService } from "./participant-service";
import { validateReasoningEffort } from "./reasoning-effort";
import {
  AttachmentClaimConflictError,
  type SessionAttachmentRepository,
} from "./session-attachment-repository";
import { SessionAttachmentError, resolveSessionAttachments } from "./session-attachment-resolver";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionStatusService } from "./session-status-service";
import type { SessionRow } from "./types";

/** Live model-auth and recovery gates shared by admission and dispatch. */
export interface PromptPolicy {
  getProviderAuthenticationError(model: string): Promise<string | null>;
  getSandboxPromptBlockReason(): string | null;
}

export class SessionNotPromptableError extends Error {
  constructor(readonly sessionStatus: SessionRow["status"]) {
    super(`Cannot prompt a ${sessionStatus} session`);
    this.name = "SessionNotPromptableError";
  }
}

export class SandboxPromptBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPromptBlockedError";
  }
}

export class BudgetExhaustedError extends Error {
  constructor() {
    super(
      "Session cost limit reached. The session owner must raise or remove the limit to continue."
    );
    this.name = "BudgetExhaustedError";
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

/** A per-prompt model override the session's harness cannot run. */
export class HarnessModelIncompatibleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessModelIncompatibleError";
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

/**
 * Admits already-authorized ordinary prompts without dispatching them. New work
 * is persisted and projected before returning; retries return the original
 * receipt. Both schedule activity updates. Callers acknowledge and drive execution.
 */
export class SessionPromptAdmission {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly log: Logger,
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: MessageRepository,
    private readonly participantRepository: ParticipantRepository,
    private readonly attachmentRepository: SessionAttachmentRepository,
    private readonly participantService: ParticipantService,
    private readonly sessionStatus: SessionStatusService,
    private readonly messenger: SessionMessenger,
    private readonly sessionIndex: SessionIndexStore,
    private readonly policy: PromptPolicy
  ) {}

  async enqueueFromWeb(
    client: Pick<ClientInfo, "participantId" | "userId" | "name">,
    data: PromptMessageData
  ): Promise<EnqueuedPrompt> {
    this.assertPromptableSession();
    this.assertSandboxAcceptingPrompts();
    let participant = this.participantRepository.getParticipantById(client.participantId);
    participant ??= this.participantService.getByUserId(client.userId);
    if (!participant) {
      this.assertBudgetAvailable();
      this.assertQueueCapacity();
      participant = this.participantService.create(client.userId, client.name);
    }
    const enqueued = await this.enqueuePromptCore({
      participant,
      userId: client.userId,
      content: data.content,
      source: "web",
      model: data.model,
      reasoningEffort: data.reasoningEffort,
      attachments: data.attachments,
      clientRequestId: data.clientRequestId,
    });
    this.touchSessionActivity();
    return enqueued;
  }

  async enqueueFromApi(data: EnqueuePromptRequest): Promise<EnqueuedPrompt> {
    this.assertPromptableSession();
    this.assertSandboxAcceptingPrompts();
    // A request id naming a prompt already queued is answered by enqueuePromptCore's
    // idempotency lookup, whatever the budget or capacity is now. New work is refused
    // here, before any participant changes.
    if (
      !data.clientRequestId ||
      !this.messageRepository.getMessageByClientRequestId(data.clientRequestId)
    ) {
      this.assertBudgetAvailable();
      this.assertQueueCapacity();
    }
    let participant = this.participantService.getByUserId(data.authorId);
    if (!participant) {
      const name = data.scmEnrichment?.name || data.authorId;
      participant = data.canonicalUserId
        ? this.participantService.create(data.authorId, name, data.canonicalUserId)
        : this.participantService.create(data.authorId, name);
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
      clientRequestId: data.clientRequestId,
      canonicalUserId: data.canonicalUserId,
      scmEnrichment: data.scmEnrichment,
    });

    // An already-active session keeps its index timestamp through the status sync, so
    // record the activity here: session continuity measures its window from it.
    this.touchSessionActivity();
    return enqueued;
  }

  /** The original message for a retried clientRequestId, or a conflict if the request differs. */
  private findDuplicatePrompt(
    data: EnqueuePromptCoreData,
    requestFingerprint: string | undefined
  ): EnqueuedPrompt | null {
    if (!data.clientRequestId) return null;
    const queueDepthBefore = this.messageRepository.getPendingOrProcessingCount();
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
        deduplicated: true,
      };
    }
    return null;
  }

  private async enqueuePromptCore(data: EnqueuePromptCoreData): Promise<EnqueuedPrompt> {
    const session = this.repository.getSession();
    const harness = getValidHarnessOrDefault(session?.harness);
    const strictSelection = getHarnessCapabilities(harness).selectionPolicy === "strict";
    let requestFingerprint: string | undefined;
    if (data.clientRequestId) {
      requestFingerprint = await fingerprintWebPrompt(data.participant.id, data);
    }
    if (strictSelection) {
      // A retry of an accepted request returns its original message before the
      // mutable model/auth policy is consulted: it is not new work.
      const duplicate = this.findDuplicatePrompt(data, requestFingerprint);
      if (duplicate) return duplicate;
      const modelError = await this.policy.getProviderAuthenticationError(
        data.model || session?.model || DEFAULT_MODEL
      );
      if (modelError) throw new HarnessModelIncompatibleError(modelError);
    }

    // Keep the promptability check, idempotency lookup, budget and capacity
    // checks, and insert in one synchronous turn so concurrent requests cannot
    // race between them. The fingerprint hash above is a non-storage await: a
    // cancel or archive can land while this request is suspended, so the
    // session is read after it, not before.
    this.assertPromptableSession();
    this.assertSandboxAcceptingPrompts();
    const queueDepthBefore = this.messageRepository.getPendingOrProcessingCount();
    // Also rechecked after the policy await: a concurrent identical request may
    // have been inserted while this one was suspended.
    const raced = this.findDuplicatePrompt(data, requestFingerprint);
    if (raced) return raced;
    this.assertBudgetAvailable();
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
      if (strictSelection || isValidModel(data.model)) {
        // Preserve strict overrides so compatibility rejects them below,
        // rather than silently substituting the session's model.
        messageModel = data.model;
      } else {
        this.log.warn("Invalid message model, ignoring override", { model: data.model });
      }
    }

    const effectiveModelForEffort =
      messageModel || this.repository.getSession()?.model || DEFAULT_MODEL;
    const incompatibility = checkHarnessPromptCompatibility(
      harness,
      effectiveModelForEffort,
      data.reasoningEffort ??
        inheritReasoningEffort(
          harness,
          effectiveModelForEffort,
          this.repository.getSession()?.reasoning_effort
        )
    );
    if (incompatibility) throw new HarnessModelIncompatibleError(incompatibility.message);
    const messageReasoningEffort = validateReasoningEffort(
      effectiveModelForEffort,
      data.reasoningEffort,
      this.log,
      getValidHarnessOrDefault(this.repository.getSession()?.harness)
    );

    // Only new work refreshes identity. Keep this after both duplicate checks
    // and synchronous with insertion so a retry cannot restore stale attribution.
    if (data.canonicalUserId) {
      this.participantRepository.updateParticipantCoalesce(data.participant.id, {
        canonicalUserId: data.canonicalUserId,
      });
    }
    if (data.scmEnrichment !== undefined) {
      const enrichment = data.scmEnrichment;
      this.participantRepository.updateParticipantIdentity(data.participant.id, {
        canonicalUserId: data.canonicalUserId ?? data.participant.canonical_user_id ?? null,
        scmName: enrichment.name,
        scmEmail: enrichment.email,
        scmLogin: enrichment.login,
        scmUserId: enrichment.userId,
      });
    }

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

    return { messageId, position, deduplicated: false };
  }

  /** Refresh the session index's activity timestamp in the background. */
  private touchSessionActivity(): void {
    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id;
    if (!sessionId) return;
    this.backgroundTasks.submit(() => this.sessionIndex.touchUpdatedAt(sessionId), {
      name: "session_index.touch_updated_at",
      context: { session_id: sessionId },
    });
  }

  private assertBudgetAvailable(): void {
    if (this.repository.getSession()?.budget_exhausted === 1) {
      throw new BudgetExhaustedError();
    }
  }

  private assertPromptableSession(): void {
    const session = this.repository.getSession();
    if (session && !isSessionPromptable(session.status)) {
      throw new SessionNotPromptableError(session.status);
    }
  }

  private assertSandboxAcceptingPrompts(): void {
    const reason = this.policy.getSandboxPromptBlockReason();
    if (reason) throw new SandboxPromptBlockedError(reason);
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

  private broadcastPromptQueue(): void {
    this.messenger.broadcast({
      type: "prompt_queue_updated",
      promptQueue: this.messageRepository.listPromptQueue(),
    });
  }
}
