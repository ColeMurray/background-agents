import type { RepositoryShaEntry } from "@open-inspect/shared";

type RepositoryIdentity = Pick<RepositoryShaEntry, "repoOwner" | "repoName">;

/** Stable case-insensitive identity shared by provenance and branch reconciliation. */
export function repositoryIdentityKey(repository: RepositoryIdentity): string {
  return `${repository.repoOwner.toLowerCase()}/${repository.repoName.toLowerCase()}`;
}

/** Decode the repository SHA document used by callbacks and persisted build rows. */
export function decodeRepositoryShas(value: unknown): RepositoryShaEntry[] | null {
  if (!Array.isArray(value)) return null;

  const repositories: RepositoryShaEntry[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return null;
    const { repoOwner, repoName, baseSha } = entry as Record<string, unknown>;
    if (
      typeof repoOwner !== "string" ||
      repoOwner.length === 0 ||
      typeof repoName !== "string" ||
      repoName.length === 0 ||
      typeof baseSha !== "string" ||
      baseSha.length === 0
    ) {
      return null;
    }
    repositories.push({ repoOwner, repoName, baseSha });
  }
  return repositories;
}

/** Parse and decode a D1 JSON provenance column without leaking exceptions. */
export function parseRepositoryShasJson(value: string): RepositoryShaEntry[] | null {
  try {
    return decodeRepositoryShas(JSON.parse(value));
  } catch {
    return null;
  }
}
