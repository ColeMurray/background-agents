import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
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
    private readonly wsManager: SessionWebSocketManager,
    private readonly applySessionTitleUpdate: (
      title: string,
      options?: SessionTitleUpdateOptions
    ) => SessionTitleUpdateResult,
    private readonly updateLastActivity: (timestamp: number) => void,
    private readonly scheduleInactivityCheck: () => Promise<void>,
    private readonly processMessageQueue: () => Promise<void>,
    private readonly isProviderStartupPending: () => boolean,
    private readonly scheduleDisconnectCheck: () => Promise<void>
  ) {}

  handleHeartbeat(
    event: Extract<SandboxEvent, { type: "heartbeat" }>,
    context: SandboxEventContext
  ): void {
    if (context.sender && !this.wsManager.isCurrentSandboxSocket(context.sender, event.sandboxId)) {
      return;
    }
    this.sandboxRepository.updateSandboxHeartbeat(context.now);
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
    const status = this.sandboxRepository.getSandbox()?.status;
    if (!context.sender) {
      this.recordReadyMetadata(event, context);
      return;
    }
    if (
      !status ||
      !["spawning", "connecting", "failed", "ready", "snapshotting"].includes(status) ||
      !this.wsManager.isCurrentSandboxSocket(context.sender, event.sandboxId)
    ) {
      return;
    }

    if (status !== "ready") this.recordReadyMetadata(event, context);
    if (status === "snapshotting") {
      this.sandboxRepository.updateSandboxHeartbeat(context.now);
      await this.scheduleDisconnectCheck();
      return;
    }

    this.sandboxRepository.updateSandboxStatus("ready");
    this.sandboxRepository.updateSandboxHeartbeat(context.now);
    this.updateLastActivity(context.now);
    await this.scheduleDisconnectCheck();
    await this.scheduleInactivityCheck();
    this.messenger.broadcast({ type: "sandbox_status", status: "ready" });
    if (!this.isProviderStartupPending()) {
      this.messenger.broadcast({ type: "sandbox_access_changed" });
    }
    await this.processMessageQueue();
  }

  private recordReadyMetadata(
    event: Extract<SandboxEvent, { type: "ready" }>,
    context: SandboxEventContext
  ): void {
    this.diffService.pinBaselines(event);
    // Fills the column a fresh spawn cleared; a restore has already seeded
    // the snapshot's version, which outranks whatever this sandbox reports.
    this.sandboxRepository.recordReportedSandboxRuntimeVersion(event.runtimeVersion ?? null);
    persistSandboxEvent(this.eventRepository, event, context);
    this.messenger.broadcast({ type: "sandbox_event", event });
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
