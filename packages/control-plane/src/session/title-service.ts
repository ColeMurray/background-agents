import type { BackgroundTasks } from "../platform-ports";
import type { SessionIndexStore } from "../db/session-index";
import type { SessionMessenger } from "./messenger";
import type { SessionCoreRepository } from "./session-core-repository";
import type { SessionStatusService } from "./session-status-service";
import { resolvePublicSessionId } from "./public-session-id";
import {
  normalizeSessionTitle,
  type SessionTitleUpdateOptions,
  type SessionTitleUpdateResult,
} from "./title";

export interface SessionTitleServiceDeps {
  sessionCoreRepository: SessionCoreRepository;
  messenger: SessionMessenger;
  statusService: Pick<SessionStatusService, "notifyParentOfChildUpdate">;
  backgroundTasks: BackgroundTasks;
  /** Null when the deployment has no D1 binding — the index sync is skipped. */
  sessionIndexStore: SessionIndexStore | null;
  durableObjectId: string;
  now: () => number;
}

/**
 * Applies session title updates: normalization, persistence, the D1 session
 * index sync, the `session_title` broadcast, and parent notification for child
 * sessions.
 */
export class SessionTitleService {
  constructor(private readonly deps: SessionTitleServiceDeps) {}

  applySessionTitleUpdate(
    title: string,
    options: SessionTitleUpdateOptions = {}
  ): SessionTitleUpdateResult {
    const { sessionCoreRepository, messenger, statusService, durableObjectId, now } = this.deps;
    const normalized = normalizeSessionTitle(title);
    if (!normalized.ok) {
      return { ok: false, reason: "invalid", error: normalized.error };
    }
    const titleText = normalized.title;

    const session = sessionCoreRepository.getSession();
    if (!session) {
      return { ok: false, reason: "not_found", error: "Session not found" };
    }

    const updatedAt = Math.max(now(), session.updated_at + 1);
    if (options.onlyIfUnset) {
      const didUpdate = sessionCoreRepository.updateSessionTitleIfUnset(
        session.id,
        titleText,
        updatedAt
      );
      if (!didUpdate) {
        return { ok: false, reason: "already_set", error: "Session title is already set" };
      }
    } else {
      sessionCoreRepository.updateSessionTitle(session.id, titleText, updatedAt);
    }

    const publicSessionId = resolvePublicSessionId(session, durableObjectId);
    this.syncSessionIndexTitle(publicSessionId, titleText, updatedAt);
    messenger.broadcast({ type: "session_title", title: titleText });

    if (session.parent_session_id) {
      statusService.notifyParentOfChildUpdate({ ...session, title: titleText }, publicSessionId, {
        status: session.status,
        title: titleText,
      });
    }

    return { ok: true, title: titleText };
  }

  private syncSessionIndexTitle(sessionId: string, title: string, updatedAt: number): void {
    const { sessionIndexStore, backgroundTasks } = this.deps;
    if (!sessionIndexStore) return;
    backgroundTasks.submit(
      () => sessionIndexStore.updateTitleIfNewer(sessionId, title, updatedAt),
      {
        name: "session_index.update_title",
        context: { session_id: sessionId, updated_at: updatedAt },
      }
    );
  }
}
