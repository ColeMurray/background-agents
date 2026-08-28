import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { BackgroundTasks } from "../../platform-ports";
import type { SessionDiffService } from "../diffs/service";
import type { EventRepository } from "../event-repository";
import type { SessionMessenger } from "../messenger";
import type { SandboxRepository } from "../sandbox-repository";
import type { SessionCoreRepository } from "../session-core-repository";
import type { SessionTitleUpdateOptions, SessionTitleUpdateResult } from "../title";
import type { SessionWebSocketManager } from "../websocket-manager";
import { persistSandboxEvent, type SandboxEventContext } from "./context";

/**
 * Sandbox-runtime family: events about the sandbox itself rather than the
 * execution inside it — liveness (`heartbeat`), boot (`ready`), repository
 * sync (`git_sync`), and the runtime's title suggestion (`session_title`).
 * Heartbeat and title are pure side effects; ready and git_sync also land
 * on the timeline.
 */
export class SandboxRuntimeEventHandler {
  constructor(
    private readonly repository: SessionCoreRepository,
    private readonly sandboxRepository: SandboxRepository,
    private readonly eventRepository: EventRepository,
    private readonly messenger: SessionMessenger,
    private readonly diffService: SessionDiffService,
    private readonly applySessionTitleUpdate: (
      title: string,
      options?: SessionTitleUpdateOptions
    ) => SessionTitleUpdateResult,
    private readonly updateLastActivity: (timestamp: number) => void,
    private readonly wsManager: SessionWebSocketManager,
    private readonly backgroundTasks: BackgroundTasks,
    private readonly cleanupFailedBoot: (sandboxId: string) => Promise<void>,
    private readonly scheduleInactivityCheck: () => Promise<void>,
    private readonly processMessageQueue: () => Promise<void>
  ) {}

  handleHeartbeat(
    event: Extract<SandboxEvent, { type: "heartbeat" }>,
    context: SandboxEventContext
  ): void {
    if (!this.acceptCurrentSender(event.sandboxId, context)) return;
    this.sandboxRepository.updateSandboxHeartbeat(context.now);
    if (context.sender?.protocolVersion === 2 && event.phase) {
      this.sandboxRepository.recordBootPhase(event.sandboxId, event.phase, context.now);
    }
    // A quiet tool call may emit no events for longer than the inactivity
    // timeout. While its message is processing, the bridge heartbeat proves
    // the sandbox is still occupied and should renew its activity timestamp.
    if (context.processingMessage !== null) {
      this.updateLastActivity(context.now);
    }
  }

  handleSessionTitle(event: Extract<SandboxEvent, { type: "session_title" }>): void {
    this.applySessionTitleUpdate(event.title, { onlyIfUnset: true });
  }

  async handleReady(
    event: Extract<SandboxEvent, { type: "ready" }>,
    context: SandboxEventContext
  ): Promise<void> {
    if (!this.acceptCurrentSender(event.sandboxId, context)) return;
    const sender = context.sender;
    const sandboxBefore =
      sender?.protocolVersion === 2 ? this.sandboxRepository.getSandbox() : null;
    if (sender?.protocolVersion === 2) {
      if (!this.wsManager.updateSandboxAttachment(sender.socket, true)) return;
      if (!this.sandboxRepository.markExecutionReady(sender.sandboxId, context.now)) {
        this.wsManager.updateSandboxAttachment(sender.socket, false);
        return;
      }
    }
    this.diffService.pinBaselines(event);
    // Fills the column a fresh spawn cleared; a restore has already seeded
    // the snapshot's version, which outranks whatever this sandbox reports.
    this.sandboxRepository.recordReportedSandboxRuntimeVersion(event.runtimeVersion ?? null);
    persistSandboxEvent(this.eventRepository, event, context);
    this.messenger.broadcast({ type: "sandbox_event", event });
    if (sender?.protocolVersion === 2 && sandboxBefore?.status !== "snapshotting") {
      this.messenger.broadcast({ type: "sandbox_status", status: "ready" });
      this.messenger.broadcast({ type: "sandbox_access_changed" });
      if (sandboxBefore?.ready_at === null) this.updateLastActivity(context.now);
      await this.scheduleInactivityCheck();
      await this.processMessageQueue();
    }
  }

  handleBootPhase(
    event: Extract<SandboxEvent, { type: "boot_phase" }>,
    context: SandboxEventContext
  ): void {
    if (!this.acceptCurrentSender(event.sandboxId, context)) return;
    if (context.sender?.protocolVersion !== 2) return;
    this.sandboxRepository.recordBootPhase(event.sandboxId, event.phase, context.now);
  }

  handleBootFailed(
    event: Extract<SandboxEvent, { type: "boot_failed" }>,
    context: SandboxEventContext
  ): boolean {
    const sender = context.sender;
    if (!sender || sender.protocolVersion !== 2) return false;
    if (event.sandboxId !== sender.sandboxId) {
      this.wsManager.close(sender.socket, 1008, "Sandbox identity mismatch");
      return false;
    }
    if (!this.wsManager.isCurrentSandboxSender(sender)) {
      this.wsManager.send(sender.socket, { type: "ack", ackId: event.ackId });
      return false;
    }

    const failed = this.sandboxRepository.failBoot(
      sender.sandboxId,
      event.phase,
      event.code,
      event.message,
      context.now
    );
    if (!failed) {
      this.wsManager.send(sender.socket, { type: "ack", ackId: event.ackId });
      return false;
    }

    this.messenger.broadcast({ type: "sandbox_status", status: "failed" });
    this.wsManager.send(sender.socket, { type: "ack", ackId: event.ackId });
    const cleanup = async () => {
      await this.cleanupFailedBoot(sender.sandboxId);
      await this.processMessageQueue();
    };
    this.backgroundTasks.submit(cleanup, {
      name: "sandbox.boot_failure_cleanup",
      context: { sandbox_id: sender.sandboxId, failure_code: event.code },
    });
    return false;
  }

  private acceptCurrentSender(eventSandboxId: string, context: SandboxEventContext): boolean {
    const sender = context.sender;
    if (!sender) return true;
    if (eventSandboxId !== sender.sandboxId) {
      this.wsManager.close(sender.socket, 1008, "Sandbox identity mismatch");
      return false;
    }
    return sender.protocolVersion === 1 || this.wsManager.isCurrentSandboxSender(sender);
  }

  handleGitSync(
    event: Extract<SandboxEvent, { type: "git_sync" }>,
    context: SandboxEventContext
  ): void {
    persistSandboxEvent(this.eventRepository, event, context);
    this.sandboxRepository.updateSandboxGitSyncStatus(event.status);
    if (event.sha) {
      this.repository.updateSessionCurrentSha(event.sha);
    }
    this.messenger.broadcast({ type: "sandbox_event", event });
  }
}
