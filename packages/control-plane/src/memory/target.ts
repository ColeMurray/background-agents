import type { MemoryPartition } from "./partition";
import type { MemorySession, MemoryTarget } from "./types";

/** A session repository's partition; legacy rows without a stable ID reach no memories. */
export function repositoryPartition(repo: MemoryTarget["repositories"][number]) {
  if (repo.repoId === null || repo.repoId <= 0) return null;
  return {
    type: "repository",
    repoId: repo.repoId,
    repoOwner: repo.repoOwner,
    repoName: repo.repoName,
  } satisfies MemoryPartition;
}

/** Partitions a target draws from, in priority order: environment, repositories, personal. */
export function targetPartitions(target: MemoryTarget): MemoryPartition[] {
  return [
    ...(target.environmentId
      ? [{ type: "environment", environmentId: target.environmentId } as const]
      : []),
    ...target.repositories.flatMap((repo) => repositoryPartition(repo) ?? []),
    ...(target.personalOwnerUserId
      ? [{ type: "personal", userId: target.personalOwnerUserId } as const]
      : []),
  ];
}

/**
 * How much of the pinned personal store a session may read live. Opted-out sessions see none;
 * children see only personal records pinned in the selection they inherited, so a later
 * preference or new personal record never widens a delegated session's context.
 */
export function personalReadAccess(session: MemorySession): "none" | "pinned" | "all" {
  if (!session.target.personalOwnerUserId) return "none";
  return session.inherited ? "pinned" : "all";
}

/** Only the personal owner's own sessions may write to their personal store. */
export function canWritePersonal(session: MemorySession): boolean {
  const owner = session.target.personalOwnerUserId;
  return owner !== null && session.principal.userId === owner;
}
