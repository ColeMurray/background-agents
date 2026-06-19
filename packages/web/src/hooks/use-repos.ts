import useSWR from "swr";
import { useSession } from "next-auth/react";

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

export function useRepos(workspaceId?: string) {
  const { data: session } = useSession();

  const path = workspaceId
    ? `/api/repos?workspaceId=${encodeURIComponent(workspaceId)}`
    : "/api/repos";
  const { data, isLoading } = useSWR<ReposResponse>(session ? path : null);

  return {
    repos: data?.repos ?? [],
    loading: isLoading,
  };
}
