import useSWR from "swr";
import { sessionSkillsViewSchema, type SessionSkillsView } from "@open-inspect/shared/types/skills";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";
import type { PromptSkillSuggestionSource } from "@/lib/prompt-skill-completion";

async function fetchSessionSkills(path: BrowserApiPath): Promise<SessionSkillsView> {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new Error("Failed to load session skills");
  return sessionSkillsViewSchema.parse(await response.json());
}

export function useSessionSkills(sessionId: string) {
  const path = `/api/sessions/${sessionId}/skills` as const;
  const { data, isLoading, error } = useSWR(path, fetchSessionSkills);
  const suggestions: PromptSkillSuggestionSource = isLoading
    ? { status: "loading" }
    : error
      ? { status: "error" }
      : { status: "ready", skills: data?.skills ?? [] };
  return {
    provenance: data,
    loading: isLoading,
    error,
    suggestions,
  };
}
