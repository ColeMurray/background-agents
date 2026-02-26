import useSWR from "swr";

export interface Repo {
  path: string;
  name: string;
  defaultBranch: string;
  // Compat fields for existing components that expect GitHub-style repos
  fullName: string;
  owner: string;
}

interface ReposResponse {
  repos: Array<{ path: string; name: string; defaultBranch: string }>;
}

export function useRepos() {
  const { data, isLoading } = useSWR<ReposResponse>("/api/repos");

  const repos: Repo[] = (data?.repos ?? []).map((r) => ({
    ...r,
    fullName: r.name,
    owner: r.name,
  }));

  return {
    repos,
    loading: isLoading,
  };
}
