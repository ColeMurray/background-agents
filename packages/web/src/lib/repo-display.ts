import type { Repo } from "@/hooks/use-repos";

type RepoDisplayInfo = Pick<Repo, "fullName" | "private">;

export function getRepoSelectorLabel(repo: Pick<Repo, "fullName">) {
  return repo.fullName;
}

export function getRepoSelectorDescription(repo: Pick<Repo, "private">) {
  return repo.private ? "Private repository" : undefined;
}

export function getSelectedRepoDisplayName(
  repo: Pick<Repo, "fullName"> | undefined,
  fallback: string
) {
  return repo ? getRepoSelectorLabel(repo) : fallback;
}

export function getRepoSelectorOption(repo: RepoDisplayInfo) {
  return {
    value: repo.fullName,
    label: getRepoSelectorLabel(repo),
    description: getRepoSelectorDescription(repo),
  };
}
