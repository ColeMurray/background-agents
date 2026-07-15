import type { SessionArtifact } from "@open-inspect/shared";
import { generateId } from "../auth/crypto";
import type { Logger } from "../logger";
import type { GitPushSpec } from "../source-control";
import type { SandboxEvent, ServerMessage } from "../types";
import { shouldPersistToolCallEvent } from "./event-persistence";
import { assertArtifactType } from "./artifacts";
import type { SessionRepository } from "./repository";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionWebSocketManager } from "./websocket-manager";
import type { SessionTitleUpdateOptions, SessionTitleUpdateResult } from "./title";

type PushResolver = { resolve: () => void; reject: (err: Error) => void };
type SandboxEventWithAck = SandboxEvent & { ackId?: string };
type PushTerminalEvent = Extract<SandboxEvent, { type: "push_complete" | "push_error" }>;

interface SessionSandboxEventProcessorDeps {
  ctx: DurableObjectState;
  log: Logger;
  repository: SessionRepository;
  callbackService: CallbackNotificationService;
  wsManager: SessionWebSocketManager;
  broadcast: (message: ServerMessage) => void;
  applySessionTitleUpdate: (
    title: string,
    options?: SessionTitleUpdateOptions
  ) => SessionTitleUpdateResult;
  getIsProcessing: () => boolean;
  triggerSnapshot: (reason: string) => Promise<void>;
  reconcileSessionStatusAfterExecution: (success: boolean) => Promise<void>;
  updateLastActivity: (timestamp: number) => void;
  scheduleInactivityCheck: () => Promise<void>;
  processMessageQueue: () => Promise<void>;
}

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

  constructor(private readonly deps: SessionSandboxEventProcessorDeps) {}

  async processSandboxEvent(event: SandboxEventWithAck): Promise<void> {
    if (event.type === "heartbeat" || event.type === "token") {
      this.deps.log.debug("Sandbox event", { event_type: event.type });
    } else if (event.type !== "execution_complete") {
      this.deps.log.info("Sandbox event", { event_type: event.type });
    }
    const now = Date.now();

    // Extract ackId from the raw event (attached by bridge for critical events)
    const ackId = event.ackId;

    if (event.type === "heartbeat") {
      this.deps.repository.updateSandboxHeartbeat(now);
      return;
    }

    if (event.type === "session_title") {
      this.deps.applySessionTitleUpdate(event.title, { onlyIfUnset: true });
      return;
    }

    const eventMessageId = "messageId" in event ? event.messageId : null;
    const processingMessage = this.deps.repository.getProcessingMessage();
    const messageId = eventMessageId ?? processingMessage?.id ?? null;

    if (event.type === "artifact") {
      this.deps.updateLastActivity(now);

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

      this.deps.repository.createArtifact({
        id: artifact.id,
        type: artifact.type,
        url: artifact.url,
        metadata: artifact.metadata ? JSON.stringify(artifact.metadata) : null,
        createdAt: now,
      });
      this.deps.repository.createEvent({
        id: generateId(),
        type: event.type,
        data: JSON.stringify(augmentedEvent),
        messageId,
        createdAt: now,
      });

      this.deps.broadcast({ type: "artifact_created", artifact });
      this.deps.broadcast({ type: "sandbox_event", event: augmentedEvent });
      return;
    }

    if (event.type === "token") {
      if (messageId) {
        this.deps.repository.upsertTokenEvent(messageId, event, now);
      }
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "step_start" || event.type === "step_finish") {
      this.deps.updateLastActivity(now);
      if (
        event.type === "step_finish" &&
        typeof event.cost === "number" &&
        Number.isFinite(event.cost) &&
        event.cost > 0
      ) {
        this.deps.repository.addSessionCost(event.cost, now);
      }
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "tool_call") {
      this.deps.updateLastActivity(now);
      if (shouldPersistToolCallEvent(event.status)) {
        this.deps.repository.createEvent({
          id: generateId(),
          type: event.type,
          data: JSON.stringify(event),
          messageId,
          createdAt: now,
        });
      }
      this.deps.broadcast({ type: "sandbox_event", event });

      if (messageId) {
        this.deps.ctx.waitUntil(
          this.deps.callbackService.notifyToolCall(messageId, event).catch((error) => {
            this.deps.log.error("callback.tool_call.background_error", {
              message_id: messageId,
              error,
            });
          })
        );
      }
      return;
    }

    if (event.type === "tool_result") {
      this.deps.repository.createEvent({
        id: generateId(),
        type: event.type,
        data: JSON.stringify(event),
        messageId,
        createdAt: now,
      });
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "execution_complete") {
      const completionMessageId = messageId;
      if (messageId) {
        this.deps.repository.upsertExecutionCompleteEvent(messageId, event, now);
      }

      const isStillProcessing =
        completionMessageId != null && processingMessage?.id === completionMessageId;

      if (isStillProcessing) {
        const status = event.success ? "completed" : "failed";
        this.deps.repository.updateMessageCompletion(completionMessageId, status, now);

        const timestamps = this.deps.repository.getMessageTimestamps(completionMessageId);
        const totalDurationMs = timestamps ? now - timestamps.created_at : undefined;
        const processingDurationMs =
          timestamps?.started_at != null ? now - timestamps.started_at : undefined;
        const queueDurationMs =
          timestamps?.started_at != null
            ? timestamps.started_at - timestamps.created_at
            : undefined;

        this.deps.log.info("prompt.complete", {
          event: "prompt.complete",
          message_id: completionMessageId,
          outcome: event.success ? "success" : "failure",
          message_status: status,
          total_duration_ms: totalDurationMs,
          processing_duration_ms: processingDurationMs,
          queue_duration_ms: queueDurationMs,
        });

        this.deps.broadcast({ type: "sandbox_event", event });
        this.deps.broadcast({
          type: "processing_status",
          isProcessing: this.deps.getIsProcessing(),
        });
        this.deps.ctx.waitUntil(
          this.deps.callbackService.notifyComplete(completionMessageId, event.success, event.error)
        );

        await this.deps.reconcileSessionStatusAfterExecution(event.success);
      } else {
        this.deps.log.info("prompt.complete", {
          event: "prompt.complete",
          message_id: completionMessageId,
          outcome: "already_stopped",
        });
      }

      this.deps.ctx.waitUntil(this.deps.triggerSnapshot("execution_complete"));
      this.deps.updateLastActivity(now);
      await this.deps.scheduleInactivityCheck();
      await this.deps.processMessageQueue();
      this.sendAck(ackId);
      return;
    }

    this.deps.repository.createEvent({
      id: generateId(),
      type: event.type,
      data: JSON.stringify(event),
      messageId,
      createdAt: now,
    });

    if (event.type === "git_sync") {
      this.deps.repository.updateSandboxGitSyncStatus(event.status);

      if (event.sha) {
        this.deps.repository.updateSessionCurrentSha(event.sha);
      }
    }

    if (event.type === "push_complete" || event.type === "push_error") {
      this.handlePushEvent(event);
    }

    this.deps.broadcast({ type: "sandbox_event", event });

    if (CRITICAL_EVENT_TYPES.has(event.type)) {
      this.sendAck(ackId);
    }
  }

  async pushBranchToRemote(
    pushSpec: GitPushSpec
  ): Promise<{ success: true } | { success: false; error: string }> {
    const sandboxWs = this.deps.wsManager.getSandboxSocket();

    if (!sandboxWs) {
      this.deps.log.info("No sandbox connected, assuming branch was pushed manually");
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

    this.deps.log.info("Sending push command", {
      branch_name: pushSpec.targetBranch,
      repo_owner: pushSpec.repoOwner,
      repo_name: pushSpec.repoName,
    });
    this.deps.wsManager.send(sandboxWs, {
      type: "push",
      pushSpec,
    });

    try {
      await pushPromise;
      this.deps.log.info("Push completed successfully", { branch_name: pushSpec.targetBranch });
      return { success: true };
    } catch (pushError) {
      this.deps.log.error("Push failed", {
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
      this.deps.log.warn("Push event matched no pending resolver", {
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
      this.deps.log.info("Push completed, resolving promise", {
        branch_name: event.branchName ?? null,
        pending_resolvers: Array.from(this.pendingPushResolvers.keys()),
      });
      resolver.resolve();
    } else {
      const error = event.error || "Push failed";
      this.deps.log.warn("Push failed for branch", {
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
    const sandboxWs = this.deps.wsManager.getSandboxSocket();
    if (sandboxWs) {
      this.deps.wsManager.send(sandboxWs, { type: "ack", ackId });
    } else {
      this.deps.log.debug("Cannot send ACK: no sandbox socket", { ack_id: ackId });
    }
  }

  private pushResolverKey(repoOwner: string, repoName: string, branchName: string): string {
    return `${repoOwner.toLowerCase()}/${repoName.toLowerCase()}::${branchName.trim().toLowerCase()}`;
  }
}
