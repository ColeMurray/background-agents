/**
 * SessionStatusService — owns the session's `status` and its projections.
 *
 * Every status change fans out to three places: the connected clients
 * (broadcast), the D1 session index (status + terminal metrics mirror), and
 * the parent session's Durable Object (child rollup). This service is the
 * single place those projections are kept consistent; every public method is
 * a transition on that one noun.
 */

import { SessionInternalPaths } from "./contracts";
import type { SessionRuntimeClient } from "./runtime-client";
import type { Logger } from "../logger";
import type { SessionIndexStore } from "../db/session-index";
import type { SessionStatus } from "@open-inspect/shared/types/sessions";
import type { SessionRow } from "./types";
import type { SessionCoreRepository } from "./session-core-repository";
import type { MessageRepository } from "./message-repository";
import type { ArtifactRepository } from "./artifact-repository";
import type { SessionMessenger } from "./messenger";
import type { BackgroundTasks } from "../platform-ports";
import { isSessionPromptable, isTurnSettled } from "@open-inspect/shared/types/session-activity";

export class SessionStatusService {
  constructor(
    private readonly backgroundTasks: BackgroundTasks,
    private readonly log: Logger,
    private readonly repository: SessionCoreRepository,
    private readonly messageRepository: MessageRepository,
    private readonly artifactRepository: ArtifactRepository,
    private readonly messenger: SessionMessenger,
    private readonly sessionIndex: SessionIndexStore | null,
    /** Reaches the parent session's runtime for the child rollup. */
    private readonly sessions: SessionRuntimeClient
  ) {}

  /**
   * Transition the session to `status`, then project the change to clients,
   * the D1 session index, and the parent session. Returns false when the
   * session is missing or already in `status` (projections are still
   * refreshed in the same-status case).
   */
  async transition(status: SessionStatus): Promise<boolean> {
    const session = this.repository.getSession();
    if (!session) return false;

    const publicSessionId = this.getPublicSessionId(session);
    if (session.status === status) {
      await this.syncSessionIndexStatusAndAdmission(
        publicSessionId,
        status,
        session.updated_at
      ).catch((error) =>
        this.logSessionIndexStatusSyncError(publicSessionId, status, session.updated_at, error)
      );
      if (isTurnSettled(status)) {
        this.syncSessionMetrics(publicSessionId);
      }
      return false;
    }

    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    this.repository.updateSessionStatus(session.id, status, updatedAt);
    await this.projectTransition(session, publicSessionId, status, updatedAt);

    return true;
  }

  /**
   * Re-project this session's current status onto the index, for callers that
   * already know the two disagree.
   *
   * A swallowed projection failure leaves D1 behind, and the stale row keeps
   * being picked up by anything that scans on status. Unlike `transition`, this
   * claims no new activity: the session did not do anything, its mirror was
   * simply wrong, so `updated_at` is left alone.
   */
  async repairIndexStatus(): Promise<void> {
    const session = this.repository.getSession();
    if (!session || !this.sessionIndex) return;

    const publicSessionId = this.getPublicSessionId(session);
    const repaired = await this.sessionIndex
      .repairStatus(publicSessionId, session.status)
      .catch((error) => {
        this.logSessionIndexStatusSyncError(
          publicSessionId,
          session.status,
          session.updated_at,
          error
        );
        throw error;
      });

    if (repaired && session.status === "active") {
      await this.sessionIndex.finalizeChildAdmission(publicSessionId);
    }
  }

  /**
   * Atomically close the local aggregate before publishing cancellation.
   * The callback must be synchronous: no request may observe cancelled status
   * with unfinished messages, or accept work between those two mutations.
   */
  async cancel(terminalizeUnfinishedMessages: () => void): Promise<boolean> {
    const session = this.repository.getSession();
    if (!session) return false;

    const publicSessionId = this.getPublicSessionId(session);
    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    this.repository.updateSessionStatus(session.id, "cancelled", updatedAt);
    terminalizeUnfinishedMessages();
    await this.projectTransition(session, publicSessionId, "cancelled", updatedAt);

    return true;
  }

  private async projectTransition(
    session: SessionRow,
    publicSessionId: string,
    status: SessionStatus,
    updatedAt: number
  ): Promise<void> {
    await this.syncSessionIndexStatusAndAdmission(publicSessionId, status, updatedAt).catch(
      (error) => this.logSessionIndexStatusSyncError(publicSessionId, status, updatedAt, error)
    );

    this.messenger.broadcast({ type: "session_status", status });

    if (isTurnSettled(status)) {
      this.syncSessionMetrics(publicSessionId);
    }

    // Notify parent session (if this is a child) so its UI can refresh
    this.notifyParentOfStatusChange(session, publicSessionId, status);
  }

  /**
   * After an execution finishes, settle the session status: back to active
   * when more prompts are queued, otherwise completed/failed by outcome.
   * Leaves a session that was cancelled or archived meanwhile as it is.
   */
  async reconcileAfterExecution(success: boolean): Promise<void> {
    if (this.isSessionClosed()) return;
    const pendingOrProcessing = this.messageRepository.getPendingOrProcessingCount();
    const nextStatus: SessionStatus =
      pendingOrProcessing > 0 ? "active" : success ? "completed" : "failed";
    await this.transition(nextStatus);
  }

  /** Leaves a session that was cancelled or archived meanwhile as it is. */
  async reconcileAfterQueueRemoval(): Promise<void> {
    if (this.isSessionClosed()) return;
    if (this.messageRepository.getPendingOrProcessingCount() > 0) return;
    const nextStatus = this.getIdleStatusFromTerminalMessages();
    await this.transition(nextStatus);
  }

  /**
   * Whether the session has been cancelled or archived. A reconcile derives
   * the next status from message state, and message state says nothing about
   * a status the user chose; a reconcile that runs after an await (the
   * terminal projection, the stop alarm) must not move such a session, and
   * `transition` writes whatever it is given. Read in the same turn as the
   * transition it guards.
   */
  private isSessionClosed(): boolean {
    const session = this.repository.getSession();
    return session !== null && !isSessionPromptable(session.status);
  }

  async settleFromMessageState(): Promise<SessionStatus> {
    const nextStatus: SessionStatus =
      this.messageRepository.getPendingOrProcessingCount() > 0
        ? "active"
        : this.getIdleStatusFromTerminalMessages();
    await this.transition(nextStatus);
    return nextStatus;
  }

  /**
   * The status an idle session should hold, read off its finished messages.
   *
   * Falling back to `created` sends a session *backwards* into draft, which
   * looks like a bug and is not. It is reachable only when the session has no
   * messages at all -- cancelling the only pending prompt deletes its row --
   * and returning an empty session to draft is what lets the 8-hour
   * abandoned-draft sweep reclaim it. That behaviour was added deliberately
   * after dead sessions accumulated. Do not "fix" it to `completed`.
   */
  private getIdleStatusFromTerminalMessages(): SessionStatus {
    const latestMessage = this.messageRepository.getLatestTerminalMessage();
    return latestMessage ? (latestMessage.status === "failed" ? "failed" : "completed") : "created";
  }

  /**
   * Fire-and-forget notification to the parent session so its connected
   * clients can refresh the child-sessions list in real time.
   */
  notifyParentOfChildUpdate(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    update: { status: SessionStatus; title: string | null }
  ): void {
    const parentId = session.parent_session_id;
    if (!parentId) return;

    this.backgroundTasks.submit(
      () =>
        this.sessions.fetch(parentId, SessionInternalPaths.childSessionUpdate, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            childSessionId,
            status: update.status,
            title: update.title,
          }),
        }),
      {
        name: "session.notify_parent",
        context: {
          parent_id: parentId,
          child_id: childSessionId,
          status: update.status,
        },
      }
    );
  }

  private notifyParentOfStatusChange(
    session: Pick<SessionRow, "parent_session_id" | "title">,
    childSessionId: string,
    status: SessionStatus
  ): void {
    this.notifyParentOfChildUpdate(session, childSessionId, {
      status,
      title: session.title,
    });
  }

  private getPublicSessionId(session: SessionRow): string {
    return session.session_name || session.id;
  }

  private async syncSessionIndexStatusAndAdmission(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number
  ): Promise<void> {
    if (!this.sessionIndex) return;
    const projected = await this.sessionIndex.updateStatus(sessionId, status, updatedAt);
    if (projected && status === "active") {
      await this.sessionIndex.finalizeChildAdmission(sessionId);
    }
  }

  private logSessionIndexStatusSyncError(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number,
    error: unknown
  ): void {
    this.log.error("session_index.update_status.background_error", {
      session_id: sessionId,
      status,
      updated_at: updatedAt,
      error,
    });
  }

  private syncSessionMetrics(sessionId: string): void {
    const sessionIndex = this.sessionIndex;
    if (!sessionIndex) return;

    const session = this.repository.getSession();
    if (!session) return;

    const messageCount = this.messageRepository.getMessageCount();
    const activeDurationMs = this.messageRepository.getActiveDurationMs();
    const artifacts = this.artifactRepository.listArtifacts();
    const prCount = artifacts.filter((a) => a.type === "pr").length;

    this.backgroundTasks.submit(
      () =>
        sessionIndex.updateMetrics(sessionId, {
          totalCost: session.total_cost ?? 0,
          activeDurationMs,
          messageCount,
          prCount,
        }),
      {
        name: "session_index.update_metrics",
        context: { session_id: sessionId },
      }
    );
  }
}
