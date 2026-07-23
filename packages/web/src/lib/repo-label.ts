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

/**
 * Compact label for an automation's full target selection — its repositories
 * plus its environments. A single target renders as its own name; mixed or
 * multiple targets render as counts ("2 repositories + 1 environment").
 */
export function formatAutomationTargetsLabel(
  automation: {
    repositories: ReadonlyArray<{ repoOwner: string; repoName: string }>;
    environmentIds: ReadonlyArray<string>;
  },
  environments: ReadonlyArray<{ id: string; name: string }>
): string {
  const { repositories, environmentIds } = automation;
  if (environmentIds.length === 0) return formatRepositoriesLabel(repositories);
  if (environmentIds.length === 1 && repositories.length === 0) {
    return (
      environments.find((environment) => environment.id === environmentIds[0])?.name ??
      "1 environment"
    );
  }
  const parts: string[] = [];
  if (repositories.length > 0) {
    parts.push(repositories.length === 1 ? "1 repository" : `${repositories.length} repositories`);
  }
  parts.push(
    environmentIds.length === 1 ? "1 environment" : `${environmentIds.length} environments`
  );
  return parts.join(" + ");
}

/**
 * Session-card label: the primary repo with a "+N" suffix for the remaining
 * members. Scalar-era sessions (no member list, or a single member) render
 * exactly as `formatRepoLabel` — "owner/name" — so pre-multi-repo cards are
 * unchanged. Prefers the hydrated primary (`repositories[0]`) when present,
 * falling back to the scalar mirror so cards without a member list still render.
 */
export function formatSessionRepositoriesLabel(
  repoOwner: string | null | undefined,
  repoName: string | null | undefined,
  repositories?: ReadonlyArray<{ repoOwner: string; repoName: string }>
): string {
  const primary = repositories?.[0];
  const base = primary
    ? formatRepoLabel(primary.repoOwner, primary.repoName)
    : formatRepoLabel(repoOwner, repoName);
  const extra = repositories && repositories.length > 1 ? repositories.length - 1 : 0;
  return extra > 0 ? `${base} +${extra}` : base;
}
