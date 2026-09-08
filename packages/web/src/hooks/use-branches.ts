import useSWR from "swr";
import { useAuthSession } from "@/lib/auth-session";

interface BranchesResponse {
  branches: { name: string }[];
}

export function useBranches(repoOwner: string, repoName: string) {
  const { data: session } = useAuthSession();

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
