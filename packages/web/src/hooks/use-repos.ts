import useSWR from "swr";
import { getPrerequisiteStatus } from "@/lib/prerequisite-status";
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
  const resourceStatus = getPrerequisiteStatus(
    enabled && session ? data : undefined,
    enabled && (status === "loading" || isLoading),
    error
  );

  return {
    repos: data?.repos ?? [],
    status: resourceStatus,
    loading: resourceStatus === "loading",
    error,
  };
}
