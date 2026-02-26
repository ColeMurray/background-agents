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

export function useRepos() {
  const { data: session } = useSession();

  const { data, isLoading } = useSWR<ReposResponse>(session ? "/api/repos" : null);

  return {
    repos: data?.repos ?? [],
    loading: isLoading,
  };
}
