/**
 * Resolve a participant's display name for presence and message attribution.
 *
 * SCM fields remain a transport fallback while canonical profiles load in the
 * client. They are not used for identity or authorization.
 */
export function resolveParticipantName(participant: {
  scm_name: string | null;
  scm_login: string | null;
  user_id: string;
}): string {
  return participant.scm_name || participant.scm_login || participant.user_id;
}
