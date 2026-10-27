import type { MemoryPromptContextResponse } from "../../memory-prompt-context";
import type { MessageRepository } from "../../message-repository";
import type { ParticipantRepository } from "../../participant-repository";
import type { SessionCoreRepository } from "../../session-core-repository";

/**
 * Reports who the agent is acting for during a sandbox memory call: the account behind the
 * processing prompt (none for an Autofix turn), whether anyone else's prompt has reached the agent,
 * and the session that spawned this one. The control plane applies the personal memory rules to
 * this, walking up to the parent when it needs to.
 */
export class MemoryPromptContextHandler {
  constructor(
    private readonly messageRepository: Pick<
      MessageRepository,
      "getProcessingPromptOrigin" | "hasDispatchedPromptFromOtherUser"
    >,
    private readonly participantRepository: Pick<ParticipantRepository, "getParticipantById">,
    private readonly sessionCoreRepository: Pick<SessionCoreRepository, "getSession">
  ) {}

  /** `relativeToUserId` names whose prompts do not count as someone else's; defaults to the author. */
  getContext(relativeToUserId: string | null): Response {
    const session = this.sessionCoreRepository.getSession();
    if (!session) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    const processing = this.messageRepository.getProcessingPromptOrigin();
    const author =
      processing && !processing.autofix
        ? this.participantRepository.getParticipantById(processing.author_id)
        : null;
    const authorUserId = author?.canonical_user_id ?? null;
    const reference = relativeToUserId ?? authorUserId;
    const context: MemoryPromptContextResponse = {
      authorUserId,
      othersPrompted:
        reference === null || this.messageRepository.hasDispatchedPromptFromOtherUser(reference),
      parentSessionId: session.parent_session_id,
    };
    return Response.json(context);
  }
}
