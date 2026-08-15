import useSWR from "swr";
import type { ResolvedSkill } from "@open-inspect/shared/types/skills";

export interface SessionSkillsProvenance {
  manifestSha256?: string;
  resolverVersion?: number;
  resolvedAt?: number;
  selection?:
    | { mode: "all" }
    | { mode: "none" }
    | { mode: "profile"; profileId: string; profileName?: string };
  skills: ResolvedSkill[];
}

export function useSessionSkills(sessionId: string) {
  const { data, isLoading, error } = useSWR<SessionSkillsProvenance>(
    `/api/sessions/${sessionId}/skills`
  );
  return {
    provenance: data,
    loading: isLoading,
    error,
  };
}
