export const NO_REPOSITORY_LABEL = "No repository";

export function formatRepoLabel(repoOwner?: string | null, repoName?: string | null): string {
  return repoOwner && repoName ? `${repoOwner}/${repoName}` : NO_REPOSITORY_LABEL;
}

/** Compact label for an automation's repository selection. */
export function formatRepositoriesLabel(
  repositories: ReadonlyArray<{ repoOwner: string; repoName: string }>
): string {
  if (repositories.length === 0) return NO_REPOSITORY_LABEL;
  if (repositories.length === 1) {
    return formatRepoLabel(repositories[0].repoOwner, repositories[0].repoName);
  }
  return `${repositories.length} repositories`;
}
