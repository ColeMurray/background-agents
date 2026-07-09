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
  const { data: session, status } = useSession();

  const { data, isLoading } = useSWR<ReposResponse>(session ? "/api/repos" : null);

  return {
    repos: data?.repos ?? [],
    // The fetch is gated on the auth session, so the list is still loading
    // while the session itself resolves — don't report an authoritative [].
    loading: status === "loading" || isLoading,
  };
}
