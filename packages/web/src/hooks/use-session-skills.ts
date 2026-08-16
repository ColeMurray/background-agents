import useSWR from "swr";
import { sessionSkillsViewSchema, type SessionSkillsView } from "@open-inspect/shared/types/skills";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

async function fetchSessionSkills(path: BrowserApiPath): Promise<SessionSkillsView> {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new Error("Failed to load session skills");
  return sessionSkillsViewSchema.parse(await response.json());
}

export function useSessionSkills(sessionId: string) {
  const path = `/api/sessions/${sessionId}/skills` as const;
  const { data, isLoading, error } = useSWR(path, fetchSessionSkills);
  return {
    provenance: data,
    loading: isLoading,
    error,
  };
}
