import {
  checkHarnessPromptCompatibility,
  resolveHarnessModel,
  getHarnessCapabilities,
  getHarnessReasoningConfig,
  getValidHarnessOrDefault,
} from "@open-inspect/shared/harnesses";
import { inheritReasoningEffort } from "../harness-admission";
import { generateId } from "../auth/crypto";
import type { Logger } from "../logger";
import type { ResolvedSessionAttachment } from "@open-inspect/shared/types/session-attachments";
import type {
  GitHubAutofixOrigin,
  GitHubAutofixSessionCommand,
  GitHubAutofixSessionResponse,
} from "@open-inspect/shared";
import { githubAutofixOriginSchema } from "@open-inspect/shared";
import { DEFAULT_MODEL, getDefaultReasoningEffort } from "@open-inspect/shared/models";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import { isSessionPromptable } from "@open-inspect/shared/types/session-activity";
import type { SourceControlProviderName } from "../source-control";
import type { SandboxLifecycle } from "../sandbox/lifecycle/manager";
import type { ParticipantRow, PromptGitIdentity, SandboxCommand } from "./types";
import type { SessionCoreRepository } from "./session-core-repository";
import type { ParticipantRepository } from "./participant-repository";
import type { MessageRepository } from "./message-repository";
import { applySandboxRecovery } from "./sandbox-recovery";
import type { SessionMessenger } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { ParticipantService } from "./participant-service";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionStatusService } from "./session-status-service";
import { getAvatarUrl } from "./participant-service";
import { resolveParticipantName } from "./participant-name";
import type { AlarmScheduler, BackgroundTasks } from "../platform-ports";
import type { ExecutionStopCoordinator } from "./execution-stop-coordinator";
import type { MessageFailureService } from "./message-failure-service";
import { sandboxBootPhaseLogFields } from "../sandbox/boot-phase";
import { resolveGitAuthorIdentity } from "./identity";
import { validateReasoningEffort } from "./reasoning-effort";
import { parseStoredSessionAttachments } from "./session-attachment-resolver";
import type { PromptPolicy } from "./prompt-admission";

const AUTOFIX_ATTEMPT_WINDOW_MS = 24 * 60 * 60 * 1_000;
const STUCK_PROCESSING_ERROR = "Execution timed out (stuck processing)";

type EnqueueAutofixResponse = Extract<
  GitHubAutofixSessionResponse,
  { kind: "enqueued" | "duplicate" | "rejected" }
>;
type LookupAutofixResponse = Extract<GitHubAutofixSessionResponse, { kind: "found" | "not_found" }>;

type UserMessageEventWithOrigin = Extract<SandboxEvent, { type: "user_message" }> & {
  origin?: GitHubAutofixOrigin;
};

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

/** Dispatch and recovery over the durable queue, including Autofix's held-work redrive. */
export class SessionMessageQueue {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly log: Logger,
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: MessageRepository,
    private readonly participantRepository: ParticipantRepository,
    private readonly wsManager: SessionWebSocketManager,
    private readonly messenger: SessionMessenger,
    private readonly participantService: ParticipantService,
    private readonly callbackService: CallbackNotificationService,
    private readonly sessionStatus: SessionStatusService,
    private readonly policy: PromptPolicy,
    private readonly messageFailures: MessageFailureService,
    private readonly sandboxLifecycle: SandboxLifecycle,
    private readonly scmProvider: SourceControlProviderName,
    private readonly alarmScheduler: AlarmScheduler,
    private readonly executionStop: ExecutionStopCoordinator,
    /** Resolved per use so it honors settings persisted after construction. */
    private readonly getExecutionTimeoutMs: () => number
  ) {}

  async enqueueAutofix(
    command: Extract<GitHubAutofixSessionCommand, { type: "enqueue_feedback" }>
  ): Promise<EnqueueAutofixResponse> {
    const session = this.repository.getSession();
    const userId = `github:${command.author.id}`;
    const harness = getValidHarnessOrDefault(session?.harness);
    const selectionError =
      getHarnessCapabilities(harness).selectionPolicy === "strict"
        ? await this.policy.getProviderAuthenticationError(session?.model ?? DEFAULT_MODEL)
        : null;
    const currentSession = this.repository.getSession();
    const recoveryHold =
      this.policy.getSandboxPromptBlockReason() !== null || selectionError !== null;
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
        // Review feedback relayed from GitHub is never anyone's own prompt, whatever account its
        // reviewer maps to.
        authorCanonicalUserId: null,
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
      sessionClosed:
        !currentSession ||
        currentSession.status === "archived" ||
        currentSession.status === "cancelled",
    });
    const logFields = {
      feedback_key: command.feedbackKey,
      pull_request_number: command.pullRequest.number,
      artifact_id: command.pullRequest.artifactId,
      recovery_hold: recoveryHold,
    };
    if (admission.kind === "rejected") {
      this.log.info("autofix.rejected", {
        event: "autofix.rejected",
        ...logFields,
        reason: admission.reason,
      });
      return admission;
    }

    this.log.info("autofix.enqueue", {
      event: "autofix.enqueue",
      ...logFields,
      message_id: admission.messageId,
      outcome: admission.kind,
    });
    if (admission.kind === "enqueued") {
      this.broadcastPromptQueue();
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

    // Retry pending-work status projection even while recovery prevents dispatch.
    await this.sessionStatus.transition("active");
    if (this.policy.getSandboxPromptBlockReason()) return;
    await this.processMessageQueue();
  }

  /** Notify synchronously after durable cancellation, before broadcasts or status reconciliation. */
  async cancelQueuedPrompt(messageId: string, onCancelled: () => void): Promise<boolean> {
    if (!this.messageRepository.cancelPendingMessage(messageId)) return false;

    onCancelled();
    this.broadcastPromptQueue();
    this.log.info("prompt.cancelled", {
      event: "prompt.cancelled",
      message_id: messageId,
    });

    await this.sessionStatus.reconcileAfterQueueRemoval();
    return true;
  }

  async processMessageQueue(): Promise<void> {
    if (!this.sandboxLifecycle.allowsQueueProcessing()) return;
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
    const harness = getValidHarnessOrDefault(session?.harness);
    const resolvedModel = resolveHarnessModel(harness, message.model || session?.model);
    const inheritedReasoningEffort = inheritReasoningEffort(
      harness,
      resolvedModel,
      session?.reasoning_effort
    );
    // The same rule as admission, applied at dispatch: the harness is fixed
    // at create, so nothing may reach the sandbox on a model it cannot run.
    const harnessIncompatibility = checkHarnessPromptCompatibility(
      harness,
      resolvedModel,
      message.reasoning_effort ?? inheritedReasoningEffort
    );
    const authenticationError =
      harnessIncompatibility?.message ??
      (await this.policy.getProviderAuthenticationError(resolvedModel));
    if (!this.sandboxLifecycle.allowsQueueProcessing()) return;
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
    const target = this.wsManager.getSandboxCommandTarget();
    if (target.kind === "booting") {
      // A bridge is attached ahead of its boot. Nothing to spawn and nothing
      // to send: the runtime's `ready` event pumps this queue when the
      // harness is up, and the lifecycle alarms decide if the boot died.
      this.log.info("prompt.dispatch", {
        event: "prompt.dispatch",
        message_id: message.id,
        outcome: "deferred",
        reason: "sandbox_booting",
        ...sandboxBootPhaseLogFields(target.phase),
      });
      return;
    }
    if (target.kind === "unavailable") {
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

    const sandboxWs = target.socket;
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
      ),
      message.origin_context
    );
    const gitIdentity = resolveParticipantGitIdentity(author, this.scmProvider);
    const requestedEffort =
      message.reasoning_effort ??
      inheritedReasoningEffort ??
      getHarnessReasoningConfig(harness, resolvedModel)?.default ??
      getDefaultReasoningEffort(resolvedModel);
    const resolvedEffort =
      validateReasoningEffort(resolvedModel, requestedEffort ?? undefined, this.log, harness) ??
      undefined;

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

    if (!this.sandboxLifecycle.allowsQueueProcessing()) return;
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
      await this.executionStop.resumeAfterSandboxTermination();
    } else {
      this.messenger.broadcast({ type: "sandbox_event", event: userMessageEvent });
      this.messenger.broadcast({ type: "processing_status", isProcessing: true });
      this.broadcastPromptQueue();
      this.sandboxLifecycle.updateLastActivity(now);
      try {
        this.sandboxLifecycle.onPromptDispatched();
      } catch (error) {
        // The prompt is already running; a failed breaker reset must not skip its deadline.
        this.log.warn("prompt.circuit_breaker_reset_failed", {
          event: "prompt.circuit_breaker_reset_failed",
          message_id: message.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      // Execution timeout shares the DO's single alarm slot with lifecycle checks.
      const deadline = now + this.getExecutionTimeoutMs();
      await this.alarmScheduler.schedule(deadline);

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
    });
  }

  async handleFatalSandboxFailure(reason: string): Promise<void> {
    // Identified before termination, which may yield on provider I/O. A
    // sandbox serving a prompt, or still confirming a stopped one, was not
    // booting for the next one; the served prompt is already settled or is
    // failStuckProcessingMessage's to settle.
    const servingPrompt =
      this.messageRepository.getProcessingMessage() ??
      this.messageRepository.getMessageAwaitingStopConfirmation();
    const bootPrompt = servingPrompt ? null : this.messageRepository.getNextPendingMessage();
    const termination = this.sandboxLifecycle.terminateFailedSandbox(reason);
    await this.failStuckProcessingMessage(reason);
    await applySandboxRecovery(
      { messageQueue: this, executionStop: this.executionStop },
      bootPrompt,
      await termination
    );
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
   * Fail one pending prompt, the one a sandbox boot that gave up was going to
   * run. Named by id, not by queue position: the caller identified it before
   * the lifecycle work that may have yielded, and a prompt cancelled or
   * dispatched in the meantime is left alone. Later prompts stay pending and
   * dispatch on the user's next spawn, the same way a failed turn leaves the
   * queue today. Does not pump the queue — the caller has just failed the
   * sandbox, and the next spawn is the user's to start.
   */
  async failPendingMessage(messageId: string, error: string): Promise<void> {
    const message = this.messageRepository.getMessageById(messageId);
    if (!message || message.status !== "pending") return;
    if (!this.failMessage(message, error, Date.now(), "pending")) return;
    this.broadcastPromptQueue();
    await this.sessionStatus.reconcileAfterExecution(false);
  }

  /**
   * Fail a processing message that its sandbox can no longer complete.
   *
   * Only marks the message as failed and broadcasts — does NOT send a stop command
   * to the sandbox or call processMessageQueue(). This avoids races where a new
   * prompt could be dispatched to a sandbox being shut down.
   */
  async failStuckProcessingMessage(error = STUCK_PROCESSING_ERROR): Promise<void> {
    const now = Date.now();
    const processingMessage = this.messageRepository.getProcessingMessageWithCreatedAt();
    if (!processingMessage) return;

    if (!this.failMessage(processingMessage, error, now, "processing")) {
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

  broadcastPromptQueue(): void {
    this.messenger.broadcast({
      type: "prompt_queue_updated",
      promptQueue: this.messageRepository.listPromptQueue(),
    });
  }
}
