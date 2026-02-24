import { generateId } from "../auth/crypto";
import type { Logger } from "../logger";
import type { GitPushSpec } from "../source-control";
import type { SandboxEvent, ServerMessage } from "../types";
import { shouldPersistToolCallEvent } from "./event-persistence";
import type { SessionRepository } from "./repository";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionWebSocketManager } from "./websocket-manager";

type PushResolver = { resolve: () => void; reject: (err: Error) => void };

interface SessionSandboxEventProcessorDeps {
  ctx: DurableObjectState;
  log: Logger;
  repository: SessionRepository;
  callbackService: CallbackNotificationService;
  wsManager: SessionWebSocketManager;
  broadcast: (message: ServerMessage) => void;
  getIsProcessing: () => boolean;
  triggerSnapshot: (reason: string) => Promise<void>;
  updateLastActivity: (timestamp: number) => void;
  scheduleInactivityCheck: () => Promise<void>;
  processMessageQueue: () => Promise<void>;
}

export class SessionSandboxEventProcessor {
  private pendingPushResolvers = new Map<string, PushResolver>();

  constructor(private readonly deps: SessionSandboxEventProcessorDeps) {}

  async processSandboxEvent(event: SandboxEvent): Promise<void> {
    if (event.type === "heartbeat" || event.type === "token") {
      this.deps.log.debug("Sandbox event", { event_type: event.type });
    } else if (event.type !== "execution_complete") {
      this.deps.log.info("Sandbox event", { event_type: event.type });
    }
    const now = Date.now();

    if (event.type === "heartbeat") {
      this.deps.repository.updateSandboxHeartbeat(now);
      return;
    }

    const eventMessageId = "messageId" in event ? event.messageId : null;
    const processingMessage = this.deps.repository.getProcessingMessage();
    const messageId = eventMessageId ?? processingMessage?.id ?? null;

    if (event.type === "token") {
      if (messageId) {
        this.deps.repository.upsertTokenEvent(messageId, event, now);
      }
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "step_start" || event.type === "step_finish") {
      this.deps.broadcast({ type: "sandbox_event", event });
      return;
    }

    if (event.type === "tool_call") {
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

      if (messageId && event.status === "running") {
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
      if (messageId) {
        this.deps.repository.upsertExecutionCompleteEvent(messageId, event, now);
      }

      const completionMessageId = messageId;
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
          this.deps.callbackService.notifyComplete(completionMessageId, event.success)
        );
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
  }

  async pushBranchToRemote(
    branchName: string,
    pushSpec: GitPushSpec
  ): Promise<{ success: true } | { success: false; error: string }> {
    const sandboxWs = this.deps.wsManager.getSandboxSocket();

    if (!sandboxWs) {
      this.deps.log.info("No sandbox connected, assuming branch was pushed manually");
      return { success: true };
    }

    const normalizedBranch = this.normalizeBranchName(branchName);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    const pushPromise = new Promise<void>((resolve, reject) => {
      this.pendingPushResolvers.set(normalizedBranch, { resolve, reject });

      timeoutId = setTimeout(() => {
        if (this.pendingPushResolvers.has(normalizedBranch)) {
          this.pendingPushResolvers.delete(normalizedBranch);
          reject(new Error("Push operation timed out after 180 seconds"));
        }
      }, 180000);
    });

    this.deps.log.info("Sending push command", { branch_name: branchName });
    this.deps.wsManager.send(sandboxWs, {
      type: "push",
      pushSpec,
    });

    try {
      await pushPromise;
      this.deps.log.info("Push completed successfully", { branch_name: branchName });
      return { success: true };
    } catch (pushError) {
      this.deps.log.error("Push failed", {
        branch_name: branchName,
        error: pushError instanceof Error ? pushError : String(pushError),
      });
      return { success: false, error: `Failed to push branch: ${pushError}` };
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }
  }

  private handlePushEvent(event: SandboxEvent): void {
    const branchName = (event as { branchName?: string }).branchName;

    if (!branchName) {
      return;
    }

    const normalizedBranch = this.normalizeBranchName(branchName);
    const resolver = this.pendingPushResolvers.get(normalizedBranch);

    if (!resolver) {
      return;
    }

    if (event.type === "push_complete") {
      this.deps.log.info("Push completed, resolving promise", {
        branch_name: branchName,
        pending_resolvers: Array.from(this.pendingPushResolvers.keys()),
      });
      resolver.resolve();
    } else if (event.type === "push_error") {
      const error = (event as { error?: string }).error || "Push failed";
      this.deps.log.warn("Push failed for branch", { branch_name: branchName, error });
      resolver.reject(new Error(error));
    }

    this.pendingPushResolvers.delete(normalizedBranch);
  }

  private normalizeBranchName(name: string): string {
    return name.trim().toLowerCase();
  }
}
