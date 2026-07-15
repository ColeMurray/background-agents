/**
 * Resolve a participant's display name for presence and message attribution.
 *
 * Precedence: SCM display name, then SCM login, then the provider-agnostic auth
 * name (e.g. Google/OIDC `name`, for providers without SCM identity), finally
 * the raw user id as a last resort. Kept in one place so the order can't drift
 * across the (previously duplicated) call sites.
 */
export function resolveParticipantName(participant: {
  scm_name: string | null;
  scm_login: string | null;
  auth_name: string | null;
  user_id: string;
}): string {
  return (
    participant.scm_name || participant.scm_login || participant.auth_name || participant.user_id
  );
}
