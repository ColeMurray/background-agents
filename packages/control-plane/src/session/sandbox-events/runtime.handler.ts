import { toSandboxBootPhase, type SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import type { Logger } from "../../logger";
import type { BackgroundTasks } from "../../platform-ports";
import type { SessionDiffService } from "../diffs/service";
import type { EventRepository } from "../event-repository";
import type { SessionMessageQueue } from "../message-queue";
import type { SessionMessenger } from "../messenger";
import type { SandboxRepository } from "../sandbox-repository";
import type { SessionCoreRepository } from "../session-core-repository";
import type { SessionTitleUpdateOptions, SessionTitleUpdateResult } from "../title";
import { persistSandboxEvent, type SandboxEventContext } from "./context";

/**
 * Sandbox-runtime family: events about the sandbox itself rather than the
 * execution inside it — liveness (`heartbeat`), boot (`boot_progress`,
 * `ready`), repository sync (`git_sync`), and the runtime's title suggestion
 * (`session_title`). Heartbeat and title are pure side effects; the boot and
 * git_sync events also land on the timeline.
 *
 * `ready` is where the sandbox becomes usable. The bridge attaches ahead of
 * the repository boot, so the socket's existence proves only that the
 * runtime process is up; this event proves the harness is attached, and it
 * is what moves the row to `ready` and releases the prompt queue.
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
    private readonly refreshSlackActivity: (messageId: string, timestamp: number) => void,
    private readonly scheduleInactivityCheck: () => Promise<void>,
    private readonly backgroundTasks: BackgroundTasks,
    private readonly messageQueue: Pick<SessionMessageQueue, "processMessageQueue">,
    private readonly log: Logger
  ) {}

  handleHeartbeat(context: SandboxEventContext): void {
    this.sandboxRepository.updateSandboxHeartbeat(context.now);
    // A quiet tool call may emit no events for longer than the inactivity
    // timeout. While its message is processing, the bridge heartbeat proves
    // the sandbox is still occupied and should renew its activity timestamp.
    if (context.processingMessage !== null) {
      this.updateLastActivity(context.now);
      // The same proof drives Slack's assistant-thread indicator, which Slack
      // clears two minutes after the last update. Refreshing it from here, and
      // not from a timer, is what keeps it from outliving the turn it claims.
      this.refreshSlackActivity(context.processingMessage.id, context.now);
    }
  }

  handleSessionTitle(event: Extract<SandboxEvent, { type: "session_title" }>): void {
    this.applySessionTitleUpdate(event.title, { onlyIfUnset: true });
  }

  async handleReady(
    event: Extract<SandboxEvent, { type: "ready" }>,
    context: SandboxEventContext
  ): Promise<void> {
    // The runtime reports which harness actually booted; the session's
    // harness is fixed at create, so a mismatch is an image/config drift
    // worth a log line, never something to reconcile silently.
    const expectedHarness = this.repository.getSession()?.harness;
    if (event.harness && expectedHarness && event.harness !== expectedHarness) {
      this.log.warn("sandbox.harness_mismatch", {
        event: "sandbox.harness_mismatch",
        expected_harness: expectedHarness,
        reported_harness: event.harness,
      });
    }
    this.diffService.pinBaselines(event);
    // Fills the column a fresh spawn cleared; a restore has already seeded
    // the snapshot's version, which outranks whatever this sandbox reports.
    this.sandboxRepository.recordReportedSandboxRuntimeVersion(event.runtimeVersion ?? null);
    persistSandboxEvent(this.eventRepository, event, context);
    this.messenger.broadcast({ type: "sandbox_event", event });

    // Transition-only, and only for the generation that emitted the event: a
    // bridge resends `ready` on every reconnect, and a replacement reserved
    // while this event was in flight is readied by its own runtime. The
    // repository decides which rows may move.
    const row = this.sandboxRepository.getSandbox();
    if (!row) return;
    const generation = { sandboxId: row.modal_sandbox_id, createdAt: row.created_at };
    if (!this.sandboxRepository.markSandboxReady(generation)) return;
    this.log.info("sandbox.ready", { event: "sandbox.ready", harness: event.harness ?? null });
    // Activity is stamped here, not at attach: the inactivity reaper measures
    // from this value, and a long boot must not count as idle time.
    this.updateLastActivity(context.now);
    this.messenger.broadcast({ type: "sandbox_status", status: "ready" });
    this.backgroundTasks.submit(() => this.messageQueue.processMessageQueue(), {
      name: "message_queue.process",
    });
    // Armed last: the bridge does not resend `ready` unless it reconnects, so
    // the readiness commit and its publication must not sit behind a fallible
    // step. The arm itself is best-effort — an alarm is always pending while
    // a bridge is attached (the disconnect check armed at attach, re-armed by
    // every alarm run), and the scheduler keeps the earlier deadline.
    await this.scheduleInactivityCheck();
  }

  /**
   * A boot phase the supervisor reported through the bridge. Recorded once
   * per sequence number (the bridge resends its latest phase on reconnect),
   * then observed on the timeline like any other runtime fact. Never gates
   * anything: the row's status still moves only on `ready`.
   */
  handleBootProgress(
    event: Extract<SandboxEvent, { type: "boot_progress" }>,
    context: SandboxEventContext
  ): void {
    if (!this.sandboxRepository.recordBootProgress(toSandboxBootPhase(event), event.bootSeq)) {
      this.log.debug("sandbox.boot_progress_repeated", { boot_seq: event.bootSeq });
      return;
    }
    this.log.info("sandbox.boot_progress", {
      event: "sandbox.boot_progress",
      boot_seq: event.bootSeq,
      phase: event.phase,
      phase_status: event.status,
      repo_owner: event.repoOwner ?? null,
      repo_name: event.repoName ?? null,
      elapsed_ms: event.elapsedMs ?? null,
      warning: event.warning ?? false,
    });
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
