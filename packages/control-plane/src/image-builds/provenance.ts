import {
  repositoryShasSchema,
  type RepositoryShaEntry,
} from "@open-inspect/shared/types/image-builds";

type RepositoryIdentity = Pick<RepositoryShaEntry, "repoOwner" | "repoName">;

/** Stable case-insensitive identity shared by provenance and branch reconciliation. */
export function repositoryIdentityKey(repository: RepositoryIdentity): string {
  return `${repository.repoOwner.toLowerCase()}/${repository.repoName.toLowerCase()}`;
}

/** Decode the repository SHA document used by callbacks and persisted build rows. */
export function decodeRepositoryShas(value: unknown): RepositoryShaEntry[] | null {
  const parsed = repositoryShasSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Parse and decode a D1 JSON provenance column without leaking exceptions. */
export function parseRepositoryShasJson(value: string): RepositoryShaEntry[] | null {
  try {
    return decodeRepositoryShas(JSON.parse(value));
  } catch {
    return null;
  }
}
