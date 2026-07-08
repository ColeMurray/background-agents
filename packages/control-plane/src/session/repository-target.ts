import { normalizeOptionalRepositoryPair } from "@open-inspect/shared";
import type { SessionRepositoryRow } from "./repository";

/** A repository identified by owner and name (canonical casing unless noted). */
export interface RepoIdentity {
  repoOwner: string;
  repoName: string;
}

export function repoIdentityEquals(a: RepoIdentity, b: RepoIdentity): boolean {
  return (
    a.repoOwner.toLowerCase() === b.repoOwner.toLowerCase() &&
    a.repoName.toLowerCase() === b.repoName.toLowerCase()
  );
}

/** One member repository of a session, with its role and backing storage. */
export interface SessionRepositoryEntry {
  repoOwner: string;
  repoName: string;
  position: number;
  /** Whether this member is the session's primary (scalar-mirror) repo. */
  isPrimary: boolean;
  /** Backing member row; null when synthesized from the scalar mirror. */
  row: SessionRepositoryRow | null;
}

/**
 * Build a session's member list: its rows, or — for sessions predating the
 * member table — a one-entry list synthesized from the scalar mirror. The
 * single home of that fallback rule. Primary means identity-equal to the
 * scalar mirror (the mirror is what legacy consumers read), which coincides
 * with position 0 by the row-0-mirrors-scalars invariant.
 */
export function buildSessionRepositories(
  scalarRepo: RepoIdentity,
  rows: SessionRepositoryRow[]
): SessionRepositoryEntry[] {
  if (rows.length === 0) {
    return [
      {
        repoOwner: scalarRepo.repoOwner,
        repoName: scalarRepo.repoName,
        position: 0,
        isPrimary: true,
        row: null,
      },
    ];
  }
  return rows.map((row) => ({
    repoOwner: row.repo_owner,
    repoName: row.repo_name,
    position: row.position,
    isPrimary: repoIdentityEquals(
      { repoOwner: row.repo_owner, repoName: row.repo_name },
      scalarRepo
    ),
    row,
  }));
}

/** The requested repo names a repository outside the session's member list. */
export class RepositoryNotMemberError extends Error {
  constructor(requested: RepoIdentity) {
    super(`Repository ${requested.repoOwner}/${requested.repoName} is not part of this session`);
    this.name = "RepositoryNotMemberError";
  }
}

/** No repo was requested and the session has more than one member. */
export class AmbiguousRepositoryTargetError extends Error {
  constructor(members: SessionRepositoryEntry[]) {
    const memberList = members.map((member) => `${member.repoOwner}/${member.repoName}`).join(", ");
    super(
      `This session spans multiple repositories — specify repoOwner and repoName (one of: ${memberList})`
    );
    this.name = "AmbiguousRepositoryTargetError";
  }
}

/**
 * Resolve a requested target repository against a session's member list.
 * The single model for PR/push target resolution. Matching is
 * case-insensitive (via normalizeOptionalRepositoryPair); the returned
 * member carries the list's canonical casing.
 *
 * Throws instead of returning an error shape — callers own the mapping:
 * - RepositoryPairValidationError (propagated from the shared helper) when
 *   only one of repoOwner/repoName is given;
 * - AmbiguousRepositoryTargetError when no repo is requested and the
 *   session has several members;
 * - RepositoryNotMemberError when the requested repo is not a member — a
 *   security boundary, not just input validation: the PR route is reachable
 *   with sandbox auth.
 *
 * `members` must be non-empty (callers reject repo-less sessions first).
 */
export function resolveSessionRepositoryTarget(
  requested: { repoOwner?: string | null; repoName?: string | null },
  members: SessionRepositoryEntry[]
): SessionRepositoryEntry {
  if (members.length === 0) {
    throw new Error("Session has no member repositories");
  }

  const pair = normalizeOptionalRepositoryPair(requested);
  if (!pair) {
    if (members.length > 1) {
      throw new AmbiguousRepositoryTargetError(members);
    }
    return members[0];
  }

  const match = members.find((member) => repoIdentityEquals(member, pair));
  if (!match) {
    throw new RepositoryNotMemberError(pair);
  }
  return match;
}
