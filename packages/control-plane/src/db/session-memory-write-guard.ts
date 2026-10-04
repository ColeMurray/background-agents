import type { MemoryPartition } from "../memory/partition";
import type { MemoryActor } from "../memory/types";
import { sql, type SqlFragment } from "./sql-fragment";

type AgentActor = Extract<MemoryActor, { kind: "agent" }>;

function sessionReaches(partition: MemoryPartition): SqlFragment {
  switch (partition.type) {
    case "personal":
      return sql`EXISTS (SELECT 1 FROM session_memory_manifests manifest
        WHERE manifest.session_id = s.id AND manifest.personal_owner_user_id = s.user_id
          AND manifest.personal_owner_user_id = ${partition.userId})`;
    case "repository":
      return sql`EXISTS (SELECT 1 FROM session_repositories sr
        WHERE sr.session_id = s.id AND sr.repo_id = ${partition.repoId})`;
    case "environment":
      return sql`s.environment_id = ${partition.environmentId}`;
    default: {
      const exhaustive: never = partition;
      throw new Error(`Unhandled memory partition: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Commit-time preconditions for an agent insert: facts about the writing session itself, which
 * a delayed tool call must not outlive. The session is still live, its owner is not suspended,
 * and the session still reaches the target partition.
 *
 * Repository/team grants are deliberately not re-encoded here. They are checked immediately
 * before the write and rechecked on every read, and agent writes to shared scopes are proposals
 * that a human approves; duplicating grant rules in SQL would let the two copies drift.
 */
export function agentWriteGuard(actor: AgentActor, partition: MemoryPartition): SqlFragment {
  return sql`EXISTS (SELECT 1 FROM sessions s
    JOIN users u ON u.id = s.user_id AND u.suspended_at IS NULL
    WHERE s.id = ${actor.sessionId} AND s.user_id = ${actor.userId}
      AND s.status IN ('created', 'active') AND ${sessionReaches(partition)})`;
}

/**
 * Personal auto-save eligibility, rechecked at commit: sharing a session or adding a collaborator
 * revokes it in the same transaction as the audience change.
 */
export function personalAutoSaveGuard(sessionId: string, ownerUserId: string | null): SqlFragment {
  return sql`EXISTS (SELECT 1 FROM session_memory_manifests manifest
    JOIN sessions s ON s.id = manifest.session_id
    WHERE manifest.session_id = ${sessionId} AND manifest.personal_auto_save_eligible = 1
      AND manifest.personal_owner_user_id = ${ownerUserId}
      AND s.visibility = 'private' AND s.user_id = manifest.personal_owner_user_id)`;
}

/** Per-session agent quota on records written. */
export function agentWriteQuota(sessionId: string, limit: number): SqlFragment {
  return sql`(SELECT COUNT(*) FROM memories WHERE author_session_id = ${sessionId}) < ${limit}`;
}

/** Per-session quota on proposals awaiting review. */
export function pendingProposalQuota(sessionId: string, limit: number): SqlFragment {
  return sql`(SELECT COUNT(*) FROM memories
    WHERE author_session_id = ${sessionId} AND status = 'proposed') < ${limit}`;
}
