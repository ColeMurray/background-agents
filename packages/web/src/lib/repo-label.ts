export const NO_REPOSITORY_LABEL = "No repository";

export function formatRepoLabel(repoOwner?: string | null, repoName?: string | null): string {
  return repoOwner && repoName ? `${repoOwner}/${repoName}` : NO_REPOSITORY_LABEL;
}
