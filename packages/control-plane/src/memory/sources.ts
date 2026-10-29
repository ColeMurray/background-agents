import type { MemoryPartition } from "./partition";
import type { MemorySources } from "./types";

/** A session repository's partition; legacy rows without a stable ID reach no memories. */
export function repositoryPartition(repo: MemorySources["repositories"][number]) {
  if (repo.repoId === null || repo.repoId <= 0) return null;
  return { type: "repository", repoId: repo.repoId } satisfies MemoryPartition;
}

/** The partitions a session draws from, in priority order: environment, repositories, personal. */
export function sourcePartitions(sources: MemorySources): MemoryPartition[] {
  return [
    ...(sources.environmentId
      ? [{ type: "environment", environmentId: sources.environmentId } as const]
      : []),
    ...sources.repositories.flatMap((repo) => repositoryPartition(repo) ?? []),
    ...(sources.personalOwnerUserId
      ? [{ type: "personal", userId: sources.personalOwnerUserId } as const]
      : []),
  ];
}
