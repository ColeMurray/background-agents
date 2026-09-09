import type { ParticipantRepository } from "../../participant-repository";

/** HTTP boundary for the participant listing endpoint. */
export class ParticipantsHandler {
  constructor(private readonly repository: ParticipantRepository) {}

  listParticipants(): Response {
    const participants = this.repository.listParticipants();

    return Response.json({
      participants: participants.map((participant) => ({
        id: participant.id,
        userId: participant.user_id,
        ...(participant.canonical_user_id
          ? { canonicalUserId: participant.canonical_user_id }
          : {}),
        scmLogin: participant.scm_login,
        scmName: participant.scm_name,
        role: participant.role,
        joinedAt: participant.joined_at,
      })),
    });
  }
}
