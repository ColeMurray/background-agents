/** Selection key for a repository: the lowercase full name, as the API stores it. */
export function repositorySelectionKey(repoOwner: string, repoName: string): string {
  return `${repoOwner}/${repoName}`.toLowerCase();
}
