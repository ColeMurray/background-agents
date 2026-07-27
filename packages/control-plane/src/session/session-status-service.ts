/**
 * SessionStatusService — owns the session's `status` and its projections.
 *
 * Every status change fans out to three places: the connected clients
 * (broadcast), the D1 session index (status + terminal metrics mirror), and
 * the parent session's Durable Object (child rollup). This service is the
 * single place those projections are kept consistent; every public method is
 * a transition on that one noun.
 */

import { buildSessionInternalUrl, SessionInternalPaths } from "./contracts";
import type { Logger } from "../logger";
import type { SessionIndexStore } from "../db/session-index";
import type { SessionStatus } from "../types";
import type { SessionRow } from "./types";
import type { SessionRepository } from "./repository";
import type { SessionMessenger } from "./messenger";

/** Statuses that indicate a session is finished — metrics are synced to D1 on these transitions. */
const TERMINAL_STATUSES: SessionStatus[] = ["completed", "failed", "cancelled"];

export class SessionStatusService {
  constructor(
    private readonly ctx: DurableObjectState,
    private readonly log: Logger,
    private readonly repository: SessionRepository,
    private readonly messenger: SessionMessenger,
    private readonly sessionIndex: SessionIndexStore | null,
    private readonly parentSessions: DurableObjectNamespace | null
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
      await this.syncSessionIndexStatus(publicSessionId, status, session.updated_at).catch(
        (error) =>
          this.logSessionIndexStatusSyncError(publicSessionId, status, session.updated_at, error)
      );
      if (TERMINAL_STATUSES.includes(status)) {
        this.syncSessionMetrics(publicSessionId);
      }
      return false;
    }

    const updatedAt = Math.max(Date.now(), session.updated_at + 1);
    this.repository.updateSessionStatus(session.id, status, updatedAt);
    await this.syncSessionIndexStatus(publicSessionId, status, updatedAt).catch((error) =>
      this.logSessionIndexStatusSyncError(publicSessionId, status, updatedAt, error)
    );

    this.messenger.broadcast({ type: "session_status", status });

    if (TERMINAL_STATUSES.includes(status)) {
      this.syncSessionMetrics(publicSessionId);
    }

    // Notify parent session (if this is a child) so its UI can refresh
    this.notifyParentOfStatusChange(session, publicSessionId, status);

    return true;
  }

  /**
   * After an execution finishes, settle the session status: back to active
   * when more prompts are queued, otherwise completed/failed by outcome.
   */
  async reconcileAfterExecution(success: boolean): Promise<void> {
    const pendingOrProcessing = this.repository.getPendingOrProcessingCount();
    const nextStatus: SessionStatus =
      pendingOrProcessing > 0 ? "active" : success ? "completed" : "failed";
    await this.transition(nextStatus);
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
    if (!parentId || !this.parentSessions) return;

    const parentDoId = this.parentSessions.idFromName(parentId);
    const parentStub = this.parentSessions.get(parentDoId);

    this.ctx.waitUntil(
      parentStub
        .fetch(
          new Request(buildSessionInternalUrl(SessionInternalPaths.childSessionUpdate), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              childSessionId,
              status: update.status,
              title: update.title,
            }),
          })
        )
        .catch((error) => {
          this.log.error("notify_parent.failed", {
            parent_id: parentId,
            child_id: childSessionId,
            status: update.status,
            error,
          });
        })
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
    return session.session_name || session.id || this.ctx.id.toString();
  }

  private async syncSessionIndexStatus(
    sessionId: string,
    status: SessionStatus,
    updatedAt: number
  ): Promise<void> {
    if (!this.sessionIndex) return;
    await this.sessionIndex.updateStatus(sessionId, status, updatedAt);
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
    if (!this.sessionIndex) return;

    const session = this.repository.getSession();
    if (!session) return;

    const messageCount = this.repository.getMessageCount();
    const activeDurationMs = this.repository.getActiveDurationMs();
    const artifacts = this.repository.listArtifacts();
    const prCount = artifacts.filter((a) => a.type === "pr").length;

    this.ctx.waitUntil(
      this.sessionIndex
        .updateMetrics(sessionId, {
          totalCost: session.total_cost ?? 0,
          activeDurationMs,
          messageCount,
          prCount,
        })
        .catch((error) => {
          this.log.error("session_index.update_metrics.background_error", {
            session_id: sessionId,
            error,
          });
        })
    );
  }
}
