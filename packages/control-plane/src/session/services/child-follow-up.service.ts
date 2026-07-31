import { DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS } from "@open-inspect/shared";
import { parsePersistedSandboxSettings } from "../../sandbox/settings";
import { isPromptableSessionStatus, SessionNotPromptableError } from "../message-queue";
import type { SessionRepository } from "../repository";
import type { SessionRow } from "../types";
import type { MessageService } from "./message.service";

export const MAX_PENDING_CHILD_PROMPTS = 10;

export type ChildFollowUpResult =
  | { ok: true; value: { messageId: string; status: "queued" } }
  | { ok: false; status: 404 | 409 | 429 | 500; error: string };

interface ChildFollowUpServiceDeps {
  repository: Pick<SessionRepository, "listParticipants" | "getPendingOrProcessingCount">;
  getSession: () => SessionRow | null;
  getPublicSessionId: (session: SessionRow) => string;
  messageService: Pick<MessageService, "enqueuePrompt">;
  countActiveSiblingSessions: (parentSessionId: string, childSessionId: string) => Promise<number>;
}

export class ChildFollowUpService {
  constructor(private readonly deps: ChildFollowUpServiceDeps) {}

  private isPendingQueueFull(): boolean {
    return this.deps.repository.getPendingOrProcessingCount() >= MAX_PENDING_CHILD_PROMPTS;
  }

  async enqueue(request: {
    parentSessionId: string;
    content: string;
  }): Promise<ChildFollowUpResult> {
    const session = this.deps.getSession();
    if (!session || session.parent_session_id !== request.parentSessionId) {
      return { ok: false, status: 404, error: "Child session not found" };
    }
    if (!isPromptableSessionStatus(session.status)) {
      return {
        ok: false,
        status: 409,
        error: `Cannot prompt a ${session.status} session`,
      };
    }
    if (this.isPendingQueueFull()) {
      return { ok: false, status: 429, error: "Child prompt queue is full" };
    }

    if (session.status === "completed" || session.status === "failed") {
      let maxConcurrentChildren = DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS;
      try {
        maxConcurrentChildren =
          parsePersistedSandboxSettings(session.sandbox_settings).maxConcurrentChildSessions ??
          DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS;
      } catch {
        maxConcurrentChildren = DEFAULT_MAX_CONCURRENT_CHILD_SESSIONS;
      }
      const activeSiblings = await this.deps.countActiveSiblingSessions(
        request.parentSessionId,
        this.deps.getPublicSessionId(session)
      );
      if (activeSiblings >= maxConcurrentChildren) {
        return {
          ok: false,
          status: 429,
          error: `Maximum concurrent children (${maxConcurrentChildren}) reached`,
        };
      }
      if (this.isPendingQueueFull()) {
        return { ok: false, status: 429, error: "Child prompt queue is full" };
      }
    }

    const owner = this.deps.repository
      .listParticipants()
      .find((participant) => participant.role === "owner");
    if (!owner) {
      return { ok: false, status: 500, error: "No owner participant found" };
    }

    try {
      const value = await this.deps.messageService.enqueuePrompt({
        content: request.content,
        authorId: owner.user_id,
        canonicalUserId: owner.canonical_user_id ?? undefined,
        source: "agent",
      });
      return { ok: true, value };
    } catch (error) {
      if (error instanceof SessionNotPromptableError) {
        return { ok: false, status: error.status, error: error.message };
      }
      throw error;
    }
  }
}
