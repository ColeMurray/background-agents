import type { SessionParticipantProfile } from "@open-inspect/shared/types/sessions";

export function resolveParticipantDisplay(
  fallback: { name: string; avatar?: string },
  profile: SessionParticipantProfile | undefined
): { name: string; avatar?: string } {
  return {
    name: profile?.displayName || fallback.name,
    avatar: profile?.avatarUrl ?? fallback.avatar,
  };
}
