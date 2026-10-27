import type { MemoryPromptContext } from "../../../memory/types";
import type { MessageRepository } from "../../message-repository";
import type { ParticipantRepository } from "../../participant-repository";
import type { SessionCoreRepository } from "../../session-core-repository";

/**
 * Reports who the agent is acting for during a sandbox memory call: the account behind the
 * processing prompt, and whether anyone else's prompt has reached the agent. The control plane
 * applies the personal memory rules to this.
 */
export class MemoryPromptContextHandler {
  constructor(
    private readonly messageRepository: Pick<
      MessageRepository,
      "getProcessingMessageAuthor" | "hasDispatchedPromptFromOtherUser"
    >,
    private readonly participantRepository: Pick<ParticipantRepository, "getParticipantById">,
    private readonly sessionCoreRepository: Pick<SessionCoreRepository, "getSession">
  ) {}

  getContext(): Response {
    if (!this.sessionCoreRepository.getSession()) {
      return Response.json({ error: "Session not found" }, { status: 404 });
    }
    const processing = this.messageRepository.getProcessingMessageAuthor();
    const author = processing
      ? this.participantRepository.getParticipantById(processing.author_id)
      : null;
    const authorUserId = author?.canonical_user_id ?? null;
    const context: MemoryPromptContext = {
      authorUserId,
      othersPrompted:
        authorUserId === null ||
        this.messageRepository.hasDispatchedPromptFromOtherUser(authorUserId),
    };
    return Response.json(context);
  }
}
