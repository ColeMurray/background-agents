"use client";

import { sessionCollaboratorCandidatesResponseSchema } from "@open-inspect/shared/types/sessions";
import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { browserApiFetch, type BrowserApiPath } from "@/lib/browser-api-fetch";

async function fetchCandidates(path: BrowserApiPath) {
  const response = await browserApiFetch(path);
  if (!response.ok) throw new Error(`Failed to load collaborator candidates (${response.status})`);
  return sessionCollaboratorCandidatesResponseSchema.parse(await response.json());
}

export function useSessionCollaboratorCandidates(sessionId: string, enabled: boolean) {
  const { data: session } = useAuthSession();
  const key = `/api/sessions/${encodeURIComponent(sessionId)}/collaborator-candidates` as const;
  const result = useSWR(session?.user && enabled ? key : null, fetchCandidates);
  return { candidates: result.data ?? [], loading: result.isLoading, error: result.error };
}
