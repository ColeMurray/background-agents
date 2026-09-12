import {
  checkHarnessCompatibility,
  getValidHarnessOrDefault,
} from "@open-inspect/shared/harnesses";
import { generateId, hashToken } from "../auth/crypto";
import type { SessionIndexStore } from "../db/session-index";
import type { Logger } from "../logger";
import type { ResolvedSessionAttachment } from "@open-inspect/shared/types/session-attachments";
import type {
  GitHubAutofixOrigin,
  GitHubAutofixSessionCommand,
  GitHubAutofixSessionResponse,
} from "@open-inspect/shared";
import { githubAutofixOriginSchema } from "@open-inspect/shared";
import {
  DEFAULT_MODEL,
  getDefaultReasoningEffort,
  getValidModelOrDefault,
  isValidModel,
} from "@open-inspect/shared/models";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import { MAX_UNFINISHED_PROMPTS } from "@open-inspect/shared/types/prompts";
import type { ClientInfo } from "../types";
import type { SourceControlProviderName } from "../source-control";
import type { SandboxLifecycle } from "../sandbox/lifecycle/manager";
import type { ParticipantRow, PromptGitIdentity, SandboxCommand, SessionRow } from "./types";
import type { SessionCoreRepository } from "./session-core-repository";
import type { ParticipantRepository } from "./participant-repository";
import type { MessageRepository } from "./message-repository";
import { resolveExecutionBudget } from "./execution-deadline";
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
import type { AlarmScheduler, BackgroundTasks, SessionWebSocket } from "../platform-ports";
import type { ExecutionStopCoordinator } from "./execution-stop-coordinator";
import type { AlarmDeadlineStore } from "./alarm/scheduler";
import type { MessageFailureService } from "./message-failure-service";
import { resolveGitAuthorIdentity } from "./identity";
import { validateReasoningEffort } from "./reasoning-effort";
import {
  parseStoredSessionAttachments,
  SessionAttachmentError,
  resolveSessionAttachments,
} from "./session-attachment-resolver";
import type {
  EnqueuedPrompt,
  EnqueuePromptCoreData,
  PromptMessageData,
} from "./message-queue-types";

const AUTOFIX_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const SANDBOX_UNAVAILABLE_ERROR = "Sandbox became unavailable before execution completed";
const AUTOMATION_ADMISSION_EXPIRED =
  "Automation startup deadline expired before execution was dispatched";

export class AutomationAdmissionExpiredError extends Error {
  constructor() {
    super(AUTOMATION_ADMISSION_EXPIRED);
    this.name = "AutomationAdmissionExpiredError";
  }
}

function automationAdmissionDeadlineMs(
  context: Record<string, unknown> | undefined
): number | null {
  if (
    !context ||
    !["automation", "slack"].includes(String(context.source)) ||
    typeof context.runId !== "string" ||
    typeof context.executionLaunchId !== "string" ||
    context.admissionDeadlineMs === undefined
  )
    return null;
  const deadline = context.admissionDeadlineMs;
  if (typeof deadline !== "number" || !Number.isSafeInteger(deadline) || deadline <= 0) {
    throw new AutomationAdmissionExpiredError();
  }
  return deadline;
}

type EnqueueAutofixResponse = Extract<
  GitHubAutofixSessionResponse,
  { kind: "enqueued" | "duplicate" | "rejected" }
>;
type LookupAutofixResponse = Extract<GitHubAutofixSessionResponse, { kind: "found" | "not_found" }>;

type UserMessageEventWithOrigin = Extract<SandboxEvent, { type: "user_message" }> & {
  origin?: GitHubAutofixOrigin;
};

export class SessionNotPromptableError extends Error {
  constructor(readonly sessionStatus: SessionRow["status"]) {
    super(`Cannot prompt a ${sessionStatus} session`);
    this.name = "SessionNotPromptableError";
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
    private readonly getProviderAuthenticationError: (model: string) => Promise<string | null>,
    private readonly messageFailures: MessageFailureService,
    private readonly sandboxLifecycle: SandboxLifecycle,
    private readonly sessionIndex: Pick<SessionIndexStore, "touchUpdatedAt">,
    private readonly scmProvider: SourceControlProviderName,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly executionStop: ExecutionStopCoordinator,
    /** Resolved per use so it honors settings persisted after construction. */
    private readonly getExecutionTimeoutMs: () => number,
    private readonly alarmDeadlines: Pick<AlarmDeadlineStore, "setPendingEarliest">,
    private readonly getExecutionSandbox: () => {
      sandboxId: string | null;
      providerExpiresAtMs?: number | null;
      requiresStopEvidence: boolean;
      providerStartupPending?: boolean;
      turnAllowanceMs?: number;
      policySource?: string;
      runtimeUnavailable?: boolean;
    } = () => ({ sandboxId: null, requiresStopEvidence: false })
  ) {}

  async enqueueAutofix(
    command: Extract<GitHubAutofixSessionCommand, { type: "enqueue_feedback" }>
  ): Promise<EnqueueAutofixResponse> {
    const session = this.repository.getSession();
    const userId = `github:${command.author.id}`;
    const now = Date.now();
    const admission = this.messageRepository.admitAutofixMessage({
      message: {
        id: generateId(),
        authorId: () => {
          let participant = this.participantService.getByUserId(userId);
          if (!participant) {
            participant = this.participantService.create(userId, command.author.login);
          }
          this.participantRepository.updateParticipantCoalesce(participant.id, {
            scmUserId: command.author.id,
            scmLogin: command.author.login,
            scmName: command.author.login,
          });
          return participant.id;
        },
        content: command.prompt,
        source: "github",
        status: "pending",
        createdAt: now,
      },
      feedbackKey: command.feedbackKey,
      pullRequestKey: `github:${command.pullRequest.repositoryId}:${command.pullRequest.number}`,
      originContext: JSON.stringify(command.origin),
      attemptLimit: command.attemptLimit,
      windowStart: now - AUTOFIX_ATTEMPT_WINDOW_MS,
      sessionClosed: !session || session.status === "archived" || session.status === "cancelled",
    });
    if (admission.kind === "rejected") return admission;

    if (admission.kind === "enqueued") {
      this.broadcastPromptQueue();
      this.log.info("autofix.enqueue", {
        event: "autofix.enqueue",
        feedback_key: command.feedbackKey,
        message_id: admission.messageId,
        pull_request_number: command.pullRequest.number,
        artifact_id: command.pullRequest.artifactId,
      });
    }
    await this.redrivePendingAutofix(admission.messageId);
    return admission;
  }

  async lookupAutofix(feedbackKey: string): Promise<LookupAutofixResponse> {
    const messageId = this.messageRepository.getAutofixMessageId(feedbackKey);
    if (!messageId) return { kind: "not_found" };

    await this.redrivePendingAutofix(messageId);
    return { kind: "found", messageId };
  }

  private async redrivePendingAutofix(messageId: string): Promise<void> {
    if (this.messageRepository.getMessageStatus(messageId) !== "pending") return;

    const session = this.repository.getSession();
    if (!session || session.status === "archived" || session.status === "cancelled") return;

    await this.sessionStatus.transition("active");
    await this.processMessageQueue();
  }

  async handlePromptMessage(
    ws: SessionWebSocket,
    client: ClientInfo,
    data: PromptMessageData
  ): Promise<void> {
    let enqueued: EnqueuedPrompt;
    try {
      this.assertPromptableSession();
      let participant = this.participantRepository.getParticipantById(client.participantId);
      participant ??= this.participantService.getByUserId(client.userId);
      if (!participant) {
        this.assertBudgetAvailable();
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
      if (error instanceof BudgetExhaustedError) {
        this.wsManager.send(ws, {
          type: "error",
          code: "BUDGET_EXHAUSTED",
          message: error.message,
          clientRequestId: data.clientRequestId,
        });
        return;
      }
      if (error instanceof HarnessModelIncompatibleError) {
        this.wsManager.send(ws, {
          type: "error",
          code: "HARNESS_MODEL_INCOMPATIBLE",
          message: error.message,
          clientRequestId: data.clientRequestId,
        });
        return;
      }
      throw error;
    }

    const session = this.repository.getSession();
    const sessionId = session?.session_name || session?.id;
    if (sessionId) {
      this.backgroundTasks.submit(() => this.sessionIndex.touchUpdatedAt(sessionId), {
        name: "session_index.touch_updated_at",
        context: { session_id: sessionId },
      });
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
    ws: SessionWebSocket,
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
    await this.expirePendingAdmissions();
    const currentSession = this.repository.getSession();
    if (!currentSession || !isSessionPromptable(currentSession.status)) {
      return;
    }
    const awaitingStop = this.messageRepository.getMessageAwaitingStopConfirmation();
    if (awaitingStop) {
      if (awaitingStop.deadline <= Date.now()) {
        await this.executionStop.recoverStopConfirmationTimeout();
      } else {
        await this.alarmScheduler.schedule(awaitingStop.deadline);
      }
      this.log.debug("processMessageQueue: waiting for sandbox stop confirmation");
      return;
    }
    if (currentSession.budget_exhausted === 1) {
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
    const session = this.repository.getSession();
    const resolvedModel = getValidModelOrDefault(message.model || session?.model);
    // The same rule as admission, applied at dispatch: the harness is fixed
    // at create, so nothing may reach the sandbox on a model it cannot run.
    const harnessIncompatibility = checkHarnessCompatibility(
      getValidHarnessOrDefault(session?.harness),
      resolvedModel
    );
    const authenticationError =
      harnessIncompatibility?.message ?? (await this.getProviderAuthenticationError(resolvedModel));
    if (this.repository.getSession()?.budget_exhausted === 1) return;
    if (authenticationError) {
      this.log.error("provider_auth.unavailable", {
        event: "provider_auth.unavailable",
        model: resolvedModel,
      });
      if (this.failMessage(message, authenticationError, now, "pending")) {
        this.broadcastPromptQueue();
        await this.sessionStatus.reconcileAfterExecution(false);
        await this.processMessageQueue();
      }
      return;
    }
    const admissionDeadline =
      message.execution_deadline_ms == null
        ? (this.messageRepository
            .listPendingAdmissionDeadlines()
            .find((entry) => entry.id === message.id)?.deadline ?? null)
        : null;
    if (admissionDeadline !== null && admissionDeadline <= Date.now()) {
      await this.expirePendingAdmissions();
      await this.processMessageQueue();
      return;
    }
    if (this.getExecutionSandbox().runtimeUnavailable) return;
    const sandboxWs = this.wsManager.getSandboxSocket();
    if (!sandboxWs) {
      // The provider-auth lookup above is a non-storage await. The socket
      // path re-validates through the processing claim; this path has no
      // claim, so it re-reads what it acts on: a cancel or archive that
      // landed meanwhile has closed the session and terminalized the prompt,
      // and must not get a sandbox spawned for it. The queue is then pumped
      // again over the state that moved: a prompt cancelled on its own
      // leaves the next one pending with nobody else to dispatch it, and the
      // pump stops by itself for a closed session, a processing owner, a
      // stop fence, or an empty queue.
      if (!this.isPromptStillDispatchable(message.id)) {
        this.log.info("prompt.dispatch", {
          event: "prompt.dispatch",
          message_id: message.id,
          outcome: "deferred",
          reason: "superseded_during_auth",
        });
        await this.processMessageQueue();
        return;
      }
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
        () =>
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

    const dispatchAt = Date.now();
    const author = this.participantRepository.getParticipantById(message.author_id);
    if (!author) {
      throw new Error(`Missing prompt author ${message.author_id}`);
    }
    const userMessageEvent = this.createUserMessageEvent(
      author,
      message.content,
      message.id,
      dispatchAt,
      parseStoredSessionAttachments(message.attachments, () =>
        this.log.error("prompt.invalid_stored_attachments")
      ),
      message.origin_context
    );
    const gitIdentity = resolveParticipantGitIdentity(author, this.scmProvider);
    const requestedEffort =
      message.reasoning_effort ??
      session?.reasoning_effort ??
      getDefaultReasoningEffort(resolvedModel);
    const resolvedEffort =
      validateReasoningEffort(resolvedModel, requestedEffort ?? undefined, this.log) ?? undefined;

    const executionSandbox = this.getExecutionSandbox();
    if (executionSandbox.providerStartupPending) {
      // A fast bridge can connect before create/resume returns its expiry.
      // The lifecycle owner pumps the queue once that response is persisted.
      return;
    }
    const budget = resolveExecutionBudget(
      dispatchAt,
      this.getExecutionTimeoutMs(),
      executionSandbox,
      message
    );
    if (budget.executionDeadlineMs <= dispatchAt) {
      // Keep this workspace intact. Lifecycle refresh must be explicitly safe;
      // launching into an exhausted provider cannot reserve cleanup time.
      if (
        this.failMessage(
          message,
          "Insufficient remaining execution budget; runtime refresh is required",
          dispatchAt,
          "pending"
        )
      ) {
        this.broadcastPromptQueue();
        await this.sessionStatus.reconcileAfterExecution(false);
        await this.processMessageQueue();
      }
      return;
    }
    const command: SandboxCommand = {
      type: "prompt",
      messageId: message.id,
      sandboxId: budget.sandboxId ?? undefined,
      executionDeadlineMs: budget.executionDeadlineMs,
      cleanupDeadlineMs: budget.cleanupDeadlineMs,
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
      dispatchAt,
      userMessageEvent,
      budget
    );
    if (!claimed) {
      this.log.debug("processMessageQueue: prompt claim lost", { message_id: message.id });
      return;
    }

    const sent = this.wsManager.send(sandboxWs, command);

    if (!sent) {
      const recovery = this.executionStop.prepareDispatchRecovery(message.id, dispatchAt);
      if (recovery) await this.executionStop.deliverDispatchRecovery(recovery);
    } else {
      this.messenger.broadcast({ type: "sandbox_event", event: userMessageEvent });
      this.messenger.broadcast({ type: "processing_status", isProcessing: true });
      this.broadcastPromptQueue();
      this.sandboxLifecycle.updateLastActivity(now);

      // Execution timeout shares the DO's single alarm slot with lifecycle checks.
      await this.alarmScheduler.schedule(budget.executionDeadlineMs);

      this.backgroundTasks.submit(() => this.callbackService.notifyStarted(message.id), {
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
      execution_deadline_ms: budget.executionDeadlineMs,
      cleanup_deadline_ms: budget.cleanupDeadlineMs,
      execution_policy_source: executionSandbox.policySource,
      provider_expiry_known: executionSandbox.providerExpiresAtMs != null,
    });
  }

  /** Reconcile an automation observer against session-owned execution authority. */
  async reconcileExecutionState(
    automationRunId: string,
    executionLaunchId?: string,
    admissionDeadlineMs?: number
  ) {
    await this.expirePendingAdmissions();
    const processing = this.messageRepository.getProcessingMessageWithStartedAt();
    if (processing) {
      const metadata = this.messageRepository.getMessageExecutionMetadata(processing.id);
      const deadline =
        metadata?.execution_deadline_ms ??
        resolveExecutionBudget(
          processing.started_at,
          this.getExecutionTimeoutMs(),
          this.getExecutionSandbox()
        ).executionDeadlineMs;
      if (deadline <= Date.now()) await this.executionStop.stop("Execution deadline exceeded");
    }
    await this.executionStop.recoverStopConfirmationTimeout();
    const stopping = this.messageRepository.getMessageAwaitingStopConfirmation();
    const running = this.messageRepository.getProcessingMessage();
    const activeId = stopping?.id ?? running?.id;
    const metadata = activeId ? this.messageRepository.getMessageExecutionMetadata(activeId) : null;
    const message = this.messageRepository.getAutomationMessage(automationRunId);
    const hasQueuedWork = this.messageRepository.getPendingOrProcessingCount() > 0;
    const launch = executionLaunchId
      ? this.messageRepository.getExecutionLaunch(automationRunId, executionLaunchId)
      : null;
    return {
      executionState: stopping
        ? ("stopping" as const)
        : running || hasQueuedWork
          ? ("running" as const)
          : ("idle" as const),
      messageId: message?.id ?? null,
      deadlineAt: metadata?.execution_deadline_ms ?? null,
      cleanupDeadlineAt: metadata?.cleanup_deadline_ms ?? null,
      messageStatus: message?.status ?? null,
      error: message?.error_message ?? null,
      ...(executionLaunchId ? { launchObserved: launch !== null, launch } : {}),
      ...(admissionDeadlineMs === undefined
        ? {}
        : { launchAdmissionExpired: Date.now() >= admissionDeadlineMs }),
    };
  }

  /** Never-dispatched automation admission has a separate, non-renewing clock. */
  async expirePendingAdmissions(): Promise<void> {
    const now = Date.now();
    const { failures, nextDeadline } = this.repository.transaction(() => {
      const pending = this.messageRepository.listPendingAdmissionDeadlines();
      const failures = pending
        .filter((entry) => entry.deadline <= now)
        .flatMap((entry) => {
          const failure = this.messageFailures.record(
            entry.id,
            AUTOMATION_ADMISSION_EXPIRED,
            now,
            "pending"
          );
          return failure ? [failure] : [];
        });
      const future = pending.filter((entry) => entry.deadline > now).map((entry) => entry.deadline);
      const nextDeadline = future.length ? Math.min(...future) : null;
      if (nextDeadline !== null) this.alarmDeadlines.setPendingEarliest(nextDeadline);
      return { failures, nextDeadline };
    });
    for (const failure of failures) this.messageFailures.deliver(failure);
    if (failures.length) {
      this.broadcastPromptQueue();
      await this.sessionStatus.reconcileAfterQueueRemoval();
    }
    if (nextDeadline !== null) await this.alarmScheduler.schedule(nextDeadline);
  }

  async handleFatalSandboxFailure(reason: string): Promise<void> {
    if (this.messageRepository.getProcessingMessage()) {
      await this.executionStop.stop(reason);
      return;
    }
    const messageId = this.messageRepository.getMessageAwaitingStopConfirmation()?.id ?? null;
    const metadata = messageId
      ? this.messageRepository.getMessageExecutionMetadata(messageId)
      : null;
    const termination = this.sandboxLifecycle.terminateFailedSandbox(
      reason,
      metadata?.cleanup_deadline_ms ?? undefined
    );
    if (await termination)
      await this.executionStop.resumeAfterSandboxTermination(
        messageId,
        metadata?.execution_sandbox_id
      );
  }

  /** Close every unfinished message synchronously; status projection happens afterwards. */
  cancelExecution(): void {
    const now = Date.now();
    for (const message of this.messageRepository.listPendingMessagesWithCreatedAt()) {
      this.failMessage(message, "Execution was cancelled before it started", now, "pending");
    }

    const stop = this.repository.transaction(() =>
      this.executionStop.prepare("Execution was cancelled", now)
    );
    if (stop)
      this.backgroundTasks.submit(() => this.executionStop.deliver(stop), {
        name: "execution.cancel",
        context: { message_id: stop.failure.completion.messageId },
      });

    this.messenger.broadcast({ type: "processing_status", isProcessing: false });
    this.broadcastPromptQueue();
  }

  /**
   * Fail a processing message that its sandbox can no longer complete.
   *
   * Settlement cannot release an occupied runtime. Lifecycle failures converge
   * on the same containment fence as user Stop and execution expiry.
   */
  async failStuckProcessingMessage(
    error = SANDBOX_UNAVAILABLE_ERROR,
    expectedMessageId?: string | null
  ): Promise<void> {
    const current = this.messageRepository.getProcessingMessage();
    if (!current || (expectedMessageId !== undefined && current.id !== expectedMessageId)) return;
    await this.executionStop.stop(error);
  }

  private failMessage(
    message: { id: string; created_at: number },
    error: string,
    completedAt: number,
    expectedStatus: "pending" | "processing"
  ): boolean {
    const failure = this.messageFailures.record(message.id, error, completedAt, expectedStatus);
    if (!failure) return false;
    this.messageFailures.deliver(failure);
    return true;
  }

  private createUserMessageEvent(
    participant: ParticipantRow,
    content: string,
    messageId: string,
    now: number,
    attachments?: ResolvedSessionAttachment[],
    originContext?: string | null
  ): UserMessageEventWithOrigin {
    let origin: GitHubAutofixOrigin | undefined;
    if (originContext) {
      try {
        origin = githubAutofixOriginSchema.parse(JSON.parse(originContext));
      } catch {
        this.log.error("prompt.invalid_origin_context", { message_id: messageId });
      }
    }
    return {
      type: "user_message",
      content,
      messageId,
      timestamp: now / 1000,
      author: {
        participantId: participant.id,
        userId: participant.canonical_user_id ?? participant.user_id,
        name: resolveParticipantName(participant),
        avatar: getAvatarUrl(participant.scm_login, this.scmProvider, participant.scm_user_id),
      },
      ...(attachments && attachments.length > 0 ? { attachments } : {}),
      ...(origin ? { origin } : {}),
    };
  }

  async enqueuePromptFromApi(
    data: EnqueuePromptRequest
  ): Promise<{ messageId: string; status: "queued" }> {
    this.assertPromptableSession();
    this.assertBudgetAvailable();
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
    let requestFingerprint: string | undefined;
    if (data.clientRequestId) {
      requestFingerprint = await fingerprintWebPrompt(data.participant.id, data);
    }

    // Keep the promptability check, idempotency lookup, budget and capacity
    // checks, and insert in one synchronous turn so concurrent requests cannot
    // race between them. The fingerprint hash above is a non-storage await: a
    // cancel or archive can land while this request is suspended, so the
    // session is read after it, not before.
    this.assertPromptableSession();
    const admissionDeadlineMs = automationAdmissionDeadlineMs(data.callbackContext);
    if (admissionDeadlineMs !== null && admissionDeadlineMs <= Date.now())
      throw new AutomationAdmissionExpiredError();
    const queueDepthBefore = this.messageRepository.getPendingOrProcessingCount();
    if (
      (data.callbackContext?.source === "automation" || data.callbackContext?.source === "slack") &&
      typeof data.callbackContext.runId === "string" &&
      typeof data.callbackContext.executionLaunchId === "string"
    ) {
      const existing = this.messageRepository.getExecutionLaunch(
        data.callbackContext.runId,
        data.callbackContext.executionLaunchId
      );
      if (existing)
        return {
          messageId: existing.messageId,
          position: this.messageRepository.getUnfinishedMessagePosition(existing.messageId),
        };
    }
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
      if (isValidModel(data.model)) {
        // An override the session's harness cannot run is a user-visible
        // rejection, never a silent fallback to a model it can run.
        const harness = getValidHarnessOrDefault(this.repository.getSession()?.harness);
        const incompatibility = checkHarnessCompatibility(harness, data.model);
        if (incompatibility) throw new HarnessModelIncompatibleError(incompatibility.message);
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
      this.repository.transaction(() => {
        if (admissionDeadlineMs !== null && admissionDeadlineMs <= Date.now())
          throw new AutomationAdmissionExpiredError();
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
        if (admissionDeadlineMs !== null)
          this.alarmDeadlines.setPendingEarliest(admissionDeadlineMs);
      });
    } catch (error) {
      if (error instanceof AttachmentClaimConflictError) {
        throw new SessionAttachmentError(
          "One or more attachments are missing, expired, or already used"
        );
      }
      throw error;
    }

    if (admissionDeadlineMs !== null) await this.alarmScheduler.schedule(admissionDeadlineMs);
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

  private assertBudgetAvailable(): void {
    if (this.repository.getSession()?.budget_exhausted === 1) {
      throw new BudgetExhaustedError();
    }
  }

  /**
   * Whether `messageId` is still pending in a session that still accepts
   * work. Read in the caller's continuation, so the decision it feeds is made
   * on the same state.
   */
  private isPromptStillDispatchable(messageId: string): boolean {
    const session = this.repository.getSession();
    return (
      session !== null &&
      isSessionPromptable(session.status) &&
      this.messageRepository.getMessageStatus(messageId) === "pending"
    );
  }

  private assertPromptableSession(): void {
    const session = this.repository.getSession();
    if (session && !isSessionPromptable(session.status)) {
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
