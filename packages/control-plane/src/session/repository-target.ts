import {
  normalizeOptionalRepositoryPair,
  RepositoryPairValidationError,
} from "@open-inspect/shared";
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

export type SessionRepositoryTargetResolution =
  | {
      ok: true;
      repoOwner: string;
      repoName: string;
      /** The matched member row; null for sessions predating member rows. */
      memberRow: SessionRepositoryRow | null;
      /** Whether the target is the session's primary (scalar-mirror) repo. */
      isPrimary: boolean;
    }
  | { ok: false; reason: "half_specified" | "ambiguous" | "not_member"; error: string };

/**
 * Resolve a requested target repository against a session's member list.
 * The single model for PR/push target resolution — normalization (via
 * normalizeOptionalRepositoryPair), membership, and primary fallback live
 * here so callers only translate the typed result into their error shape.
 * Naming a repo outside the session is "not_member": the PR route is
 * reachable with sandbox auth, so membership is a security boundary, not
 * just input validation.
 *
 * Sessions predating member rows resolve against the scalar mirror alone.
 * An unspecified target is only valid when the session has a sole member.
 * Matching is case-insensitive; the returned identity carries the member
 * list's canonical casing.
 */
export function resolveSessionRepositoryTarget(input: {
  requested: { repoOwner?: string | null; repoName?: string | null };
  scalarRepo: RepoIdentity;
  memberRows: SessionRepositoryRow[];
}): SessionRepositoryTargetResolution {
  let requested: RepoIdentity | null;
  try {
    requested = normalizeOptionalRepositoryPair(input.requested);
  } catch (error) {
    if (error instanceof RepositoryPairValidationError) {
      return { ok: false, reason: "half_specified", error: error.message };
    }
    throw error;
  }

  const members: Array<{ identity: RepoIdentity; row: SessionRepositoryRow | null }> =
    input.memberRows.length > 0
      ? input.memberRows.map((row) => ({
          identity: { repoOwner: row.repo_owner, repoName: row.repo_name },
          row,
        }))
      : [{ identity: input.scalarRepo, row: null }];

  if (!requested) {
    if (members.length > 1) {
      const memberList = members
        .map((member) => `${member.identity.repoOwner}/${member.identity.repoName}`)
        .join(", ");
      return {
        ok: false,
        reason: "ambiguous",
        error: `This session spans multiple repositories — specify repoOwner and repoName (one of: ${memberList})`,
      };
    }
    const [sole] = members;
    return {
      ok: true,
      repoOwner: sole.identity.repoOwner,
      repoName: sole.identity.repoName,
      memberRow: sole.row,
      isPrimary: repoIdentityEquals(sole.identity, input.scalarRepo),
    };
  }

  const match = members.find((member) => repoIdentityEquals(member.identity, requested));
  if (!match) {
    return {
      ok: false,
      reason: "not_member",
      error: `Repository ${requested.repoOwner}/${requested.repoName} is not part of this session`,
    };
  }
  return {
    ok: true,
    repoOwner: match.identity.repoOwner,
    repoName: match.identity.repoName,
    memberRow: match.row,
    isPrimary: repoIdentityEquals(match.identity, input.scalarRepo),
  };
}
