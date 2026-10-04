import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";
import { usableFetchData } from "@/lib/swr-fetch-error";

export interface Repo {
  id: number;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  private: boolean;
  defaultBranch: string;
}

interface ReposResponse {
  repos: Repo[];
  teamHasRepositoryGrants?: boolean;
}

/**
 * Loads repositories for an authenticated user when enabled, allowing callers to suppress unauthorized requests.
 */
export function useRepos(enabled = true, teamId?: string | null) {
  const { data: session, status } = useAuthSession();

  const { data, isLoading, error } = useSWR<ReposResponse>(
    enabled && session
      ? teamId
        ? `/api/repos?teamId=${encodeURIComponent(teamId)}`
        : "/api/repos"
      : null
  );

  const usable = usableFetchData(data, error);

  return {
    repos: usable?.repos ?? [],
    teamHasRepositoryGrants: usable?.teamHasRepositoryGrants,
    // The fetch is gated on the auth session, so the list is still loading
    // while the session itself resolves — don't report an authoritative [].
    loading: enabled && (status === "loading" || isLoading),
    error,
  };
}
