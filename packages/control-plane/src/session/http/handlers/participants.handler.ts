import type { SessionRepository } from "../../repository";

export interface ParticipantsHandlerDeps {
  repository: Pick<SessionRepository, "listParticipants">;
}

export interface ParticipantsHandler {
  listParticipants: () => Response;
}

export function createParticipantsHandler(deps: ParticipantsHandlerDeps): ParticipantsHandler {
  return {
    listParticipants(): Response {
      const participants = deps.repository.listParticipants();

      return Response.json({
        participants: participants.map((participant) => ({
          id: participant.id,
          userId: participant.user_id,
          scmLogin: participant.scm_login,
          scmName: participant.scm_name,
          role: participant.role,
          joinedAt: participant.joined_at,
        })),
      });
    },
  };
}
