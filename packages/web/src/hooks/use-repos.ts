import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";

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
}

/**
 * Loads repositories for an authenticated user when enabled, allowing callers to suppress unauthorized requests.
 */
export function useRepos(enabled = true) {
  const { data: session, status } = useAuthSession();

  const { data, isLoading, error } = useSWR<ReposResponse>(
    enabled && session ? "/api/repos" : null
  );

  return {
    repos: data?.repos ?? [],
    // The fetch is gated on the auth session, so the list is still loading
    // while the session itself resolves — don't report an authoritative [].
    loading: enabled && (status === "loading" || isLoading),
    error,
  };
}
