import { isPromptableSessionStatus, SessionNotPromptableError } from "../message-queue";
import type { SessionRepository } from "../repository";
import type { SessionRow } from "../types";
import type { MessageService } from "./message.service";

export const MAX_PENDING_CHILD_PROMPTS = 10;

export type ChildFollowUpErrorReason =
  | "child_not_found"
  | "session_not_promptable"
  | "queue_full"
  | "owner_missing";

export class ChildFollowUpError extends Error {
  constructor(
    readonly reason: ChildFollowUpErrorReason,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "ChildFollowUpError";
  }
}

interface ChildFollowUpServiceDeps {
  repository: Pick<SessionRepository, "listParticipants" | "getPendingOrProcessingCount">;
  getSession: () => SessionRow | null;
  messageService: Pick<MessageService, "enqueuePrompt">;
}

export class ChildFollowUpService {
  constructor(private readonly deps: ChildFollowUpServiceDeps) {}

  private isPendingQueueFull(): boolean {
    return this.deps.repository.getPendingOrProcessingCount() >= MAX_PENDING_CHILD_PROMPTS;
  }

  async enqueue(request: {
    parentSessionId: string;
    content: string;
  }): Promise<{ messageId: string; status: "queued" }> {
    const session = this.deps.getSession();
    if (!session || session.parent_session_id !== request.parentSessionId) {
      throw new ChildFollowUpError("child_not_found", "Child session not found");
    }
    if (!isPromptableSessionStatus(session.status)) {
      throw new ChildFollowUpError(
        "session_not_promptable",
        `Cannot prompt a ${session.status} session`
      );
    }
    if (this.isPendingQueueFull()) {
      throw new ChildFollowUpError("queue_full", "Child prompt queue is full");
    }

    const owner = this.deps.repository
      .listParticipants()
      .find((participant) => participant.role === "owner");
    if (!owner) {
      throw new ChildFollowUpError("owner_missing", "No owner participant found");
    }

    try {
      return await this.deps.messageService.enqueuePrompt({
        content: request.content,
        authorId: owner.user_id,
        canonicalUserId: owner.canonical_user_id ?? undefined,
        source: "agent",
      });
    } catch (error) {
      if (error instanceof SessionNotPromptableError) {
        throw new ChildFollowUpError("session_not_promptable", error.message, { cause: error });
      }
      throw error;
    }
  }
}
