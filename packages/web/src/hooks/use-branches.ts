import useSWR from "swr";
import { useSession } from "next-auth/react";

interface BranchesResponse {
  branches: { name: string }[];
}

export function useBranches(repoOwner: string, repoName: string) {
  const { data: session } = useSession();

  const key =
    session && repoOwner && repoName
      ? `/api/repos/${encodeURIComponent(repoOwner)}/${encodeURIComponent(repoName)}/branches`
      : null;

  const { data, isLoading } = useSWR<BranchesResponse>(key);

  return {
    branches: data?.branches ?? [],
    loading: isLoading,
  };
}
