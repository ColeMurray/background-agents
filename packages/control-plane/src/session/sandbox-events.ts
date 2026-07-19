import type { SessionArtifact } from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import type { Logger } from "../logger";
import type { GitPushSpec } from "../source-control";
import type { SandboxEvent } from "../types";
import { shouldPersistToolCallEvent } from "./event-persistence";
import { assertArtifactType } from "./artifacts";
import type { SessionRepository } from "./repository";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionDiffService } from "./diffs/service";
import type { SessionMessenger } from "./messenger";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { SessionTitleUpdateOptions, SessionTitleUpdateResult } from "./title";

type PushResolver = { resolve: () => void; reject: (err: Error) => void };
type SandboxEventWithAck = SandboxEvent & { ackId?: string };
type PushTerminalEvent = Extract<SandboxEvent, { type: "push_complete" | "push_error" }>;

/** How long a pending push waits for its terminal event before rejecting. */
const PUSH_TIMEOUT_MS = 360_000;

/** Event types that require delivery acknowledgement. */
const CRITICAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "execution_complete",
  "error",
  "snapshot_ready",
  "push_complete",
  "push_error",
]);

export class SessionSandboxEventProcessor {
  private pendingPushResolvers = new Map<string, PushResolver>();

  constructor(
    private readonly ctx: DurableObjectState,
    // The DO swaps its logger for a request-scoped child during fetch();
    // a getter keeps this singleton reading the current logger instead of
    // capturing one by value at construction time.
    private readonly getLog: () => Logger,
    private readonly repository: SessionRepository,
    private readonly callbackService: CallbackNotificationService,
    private readonly wsManager: SessionWebSocketManager,
    private readonly messenger: SessionMessenger,
    private readonly diffService: SessionDiffService,
    private readonly applySessionTitleUpdate: (
      title: string,
      options?: SessionTitleUpdateOptions
    ) => SessionTitleUpdateResult,
    private readonly triggerSnapshot: (reason: string) => Promise<void>,
    private readonly reconcileSessionStatusAfterExecution: (success: boolean) => Promise<void>,
    private readonly updateLastActivity: (timestamp: number) => void,
    private readonly scheduleInactivityCheck: () => Promise<void>,
    private readonly processMessageQueue: () => Promise<void>
  ) {}

  private get log(): Logger {
    return this.getLog();
  }

  async processSandboxEvent(event: SandboxEventWithAck): Promise<void> {
    if (event.type === "heartbeat" || event.type === "token") {
      this.log.debug("Sandbox event", { event_type: event.type });
    } else if (event.type !== "execution_complete") {
      this.log.info("Sandbox event", { event_type: event.type });
    }
    const now = Date.now();

    // Extract ackId from the raw event (attached by bridge for critical events)
    const ackId = event.ackId;

    if (event.type === "heartbeat") {
      this.repository.updateSandboxHeartbeat(now);
      return;
    }

    if (event.type === "session_title") {
      this.applySessionTitleUpdate(event.title, { onlyIfUnset: true });
      return;
    }

    if (event.type === "ready") {
      this.diffService.pinBaselines(event);
    }

    const eventMessageId = "messageId" in event ? event.messageId : null;
    const processingMessage = this.repository.getProcessingMessage();
    const messageId = eventMessageId ?? processingMessage?.id ?? null;

    if (event.type === "artifact") {
      this.updateLastActivity(now);

      const artifactType = assertArtifactType(event.artifactType);
      const artifactId =
        typeof event.artifactId === "string" && event.artifactId.length > 0
          ? event.artifactId
          : generateId();
      const augmentedEvent: Extract<SandboxEvent, { type: "artifact" }> = {
        ...event,
        artifactType,
        artifactId,
        messageId: messageId ?? undefined,
      };
      const artifact: SessionArtifact = {
        id: artifactId,
        type: artifactType,
        url: event.url,
        metadata: event.metadata ?? null,
        createdAt: now,
        updatedAt: now,
      };

      this.repository.createArtifact({
        id: artifact.id,
        type: artifact.type,
        url: artifact.url,
        metadata: artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        createdAt: now,
      });
      this.repository.createEvent({
        id: generateId(),
        type: event.type,
        data: JSON.stringify(augmentedEvent),
        messageId,
        createdAt: now,
      });

      this.messenger.broadcast({ type: "artifact_created", artifact });
      this.messenger.broadcast({ type: "sandbox_event", event: augmentedEvent });
      return;
    }

    if (event.type === "token") {
      if (messageId) {
        this.repository.upsertTokenEvent(messageId, event, now);
      }
      this.messenger.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "step_start" || event.type === "step_finish") {
      this.updateLastActivity(now);
      if (
        event.type === "step_finish" &&
        typeof event.cost === "number" &&
        Number.isFinite(event.cost) &&
        event.cost > 0
      ) {
        this.repository.addSessionCost(event.cost, now);
      }
      this.messenger.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "tool_call") {
      this.updateLastActivity(now);
      if (shouldPersistToolCallEvent(event.status)) {
        this.repository.createEvent({
          id: generateId(),
          type: event.type,
          data: JSON.stringify(event),
          messageId,
          createdAt: now,
        });
      }
      this.messenger.broadcast({ type: "sandbox_event", event });

      if (messageId) {
        this.ctx.waitUntil(
          this.callbackService.notifyToolCall(messageId, event).catch((error) => {
            this.log.error("callback.tool_call.background_error", {
              message_id: messageId,
              error,
            });
          })
        );
      }
      return;
    }

    if (event.type === "tool_result") {
      this.repository.createEvent({
        id: generateId(),
        type: event.type,
        data: JSON.stringify(event),
        messageId,
        createdAt: now,
      });
      this.messenger.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "execution_complete") {
      const completionMessageId = messageId;
      if (messageId) {
        this.repository.upsertExecutionCompleteEvent(messageId, event, now);
      }
      const isStillProcessing =
        completionMessageId != null && processingMessage?.id === completionMessageId;

      if (isStillProcessing) {
        const status = event.success ? "completed" : "failed";
        this.repository.updateMessageCompletion(completionMessageId, status, now);

        const timestamps = this.repository.getMessageTimestamps(completionMessageId);
        const totalDurationMs = timestamps ? now - timestamps.created_at : undefined;
        const processingDurationMs =
          timestamps?.started_at != null ? now - timestamps.started_at : undefined;
        const queueDurationMs =
          timestamps?.started_at != null
            ? timestamps.started_at - timestamps.created_at
            : undefined;

        this.log.info("prompt.complete", {
          event: "prompt.complete",
          message_id: completionMessageId,
          outcome: event.success ? "success" : "failure",
          message_status: status,
          total_duration_ms: totalDurationMs,
          processing_duration_ms: processingDurationMs,
          queue_duration_ms: queueDurationMs,
        });

        this.messenger.broadcast({ type: "sandbox_event", event });
        this.messenger.broadcast({
          type: "processing_status",
          isProcessing: this.repository.getProcessingMessage() !== null,
        });
        this.ctx.waitUntil(
          this.callbackService.notifyComplete(completionMessageId, event.success, event.error)
        );

        await this.reconcileSessionStatusAfterExecution(event.success);
      } else {
        this.log.info("prompt.complete", {
          event: "prompt.complete",
          message_id: completionMessageId,
          outcome: "already_stopped",
        });
      }

      this.ctx.waitUntil(this.triggerSnapshot("execution_complete"));
      this.updateLastActivity(now);
      await this.scheduleInactivityCheck();
      await this.processMessageQueue();
      this.sendAck(ackId);
      return;
    }

    this.repository.createEvent({
      id: generateId(),
      type: event.type,
      data: JSON.stringify(event),
      messageId,
      createdAt: now,
    });

    if (event.type === "git_sync") {
      this.repository.updateSandboxGitSyncStatus(event.status);

      if (event.sha) {
        this.repository.updateSessionCurrentSha(event.sha);
      }
    }

    if (event.type === "push_complete" || event.type === "push_error") {
      this.handlePushEvent(event);
    }

    this.messenger.broadcast({ type: "sandbox_event", event });

    if (CRITICAL_EVENT_TYPES.has(event.type)) {
      this.sendAck(ackId);
    }
  }

  async pushBranchToRemote(
    pushSpec: GitPushSpec
  ): Promise<{ success: true } | { success: false; error: string }> {
    const sandboxWs = this.wsManager.getSandboxSocket();

    if (!sandboxWs) {
      this.log.info("No sandbox connected, assuming branch was pushed manually");
      return { success: true };
    }

    const resolverKey = this.pushResolverKey(
      pushSpec.repoOwner,
      pushSpec.repoName,
      pushSpec.targetBranch
    );
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const pushPromise = new Promise<void>((resolve, reject) => {
      this.pendingPushResolvers.set(resolverKey, { resolve, reject });

      timeoutId = setTimeout(() => {
        if (this.pendingPushResolvers.has(resolverKey)) {
          this.pendingPushResolvers.delete(resolverKey);
          reject(new Error(`Push operation timed out after ${PUSH_TIMEOUT_MS / 1000} seconds`));
        }
      }, PUSH_TIMEOUT_MS);
    });

    this.log.info("Sending push command", {
      branch_name: pushSpec.targetBranch,
      repo_owner: pushSpec.repoOwner,
      repo_name: pushSpec.repoName,
    });
    this.wsManager.send(sandboxWs, {
      type: "push",
      pushSpec,
    });

    try {
      await pushPromise;
      this.log.info("Push completed successfully", { branch_name: pushSpec.targetBranch });
      return { success: true };
    } catch (pushError) {
      this.log.error("Push failed", {
        branch_name: pushSpec.targetBranch,
        error: pushError instanceof Error ? pushError : String(pushError),
      });
      return { success: false, error: `Failed to push branch: ${pushError}` };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private handlePushEvent(event: PushTerminalEvent): void {
    const entry = this.findPushResolver(event);
    if (!entry) {
      this.log.warn("Push event matched no pending resolver", {
        event_type: event.type,
        branch_name: event.branchName ?? null,
        repo_owner: event.repoOwner ?? null,
        repo_name: event.repoName ?? null,
        pending_resolvers: Array.from(this.pendingPushResolvers.keys()),
      });
      return;
    }

    const [resolverKey, resolver] = entry;
    if (event.type === "push_complete") {
      this.log.info("Push completed, resolving promise", {
        branch_name: event.branchName ?? null,
        pending_resolvers: Array.from(this.pendingPushResolvers.keys()),
      });
      resolver.resolve();
    } else {
      const error = event.error || "Push failed";
      this.log.warn("Push failed for branch", {
        branch_name: event.branchName ?? null,
        error,
      });
      resolver.reject(new Error(error));
    }

    this.pendingPushResolvers.delete(resolverKey);
  }

  /**
   * Match a terminal push event to its pending resolver. Events carrying the
   * full identity match strictly by key — a fully identified miss is a stale
   * or wrong-repo event and must not settle anything. Only events missing
   * identity (legacy single-repo runtimes echo no repo identity, and their
   * "no repository found" push_error carries no branchName either) settle
   * the sole pending push — by construction only one can be in flight when
   * identity is missing.
   */
  private findPushResolver(event: PushTerminalEvent): [string, PushResolver] | null {
    if (event.repoOwner && event.repoName && event.branchName) {
      const resolverKey = this.pushResolverKey(event.repoOwner, event.repoName, event.branchName);
      const resolver = this.pendingPushResolvers.get(resolverKey);
      return resolver ? [resolverKey, resolver] : null;
    }
    if (this.pendingPushResolvers.size === 1) {
      const [sole] = this.pendingPushResolvers.entries();
      return sole;
    }
    return null;
  }

  private sendAck(ackId: string | undefined): void {
    if (!ackId) return;
    const sandboxWs = this.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.wsManager.send(sandboxWs, { type: "ack", ackId });
    } else {
      this.log.debug("Cannot send ACK: no sandbox socket", { ack_id: ackId });
    }
  }

  private pushResolverKey(repoOwner: string, repoName: string, branchName: string): string {
    return `${repoOwner.toLowerCase()}/${repoName.toLowerCase()}::${branchName.trim().toLowerCase()}`;
  }
}
