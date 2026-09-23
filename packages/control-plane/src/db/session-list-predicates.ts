import type { SessionStatus, SpawnSource } from "@open-inspect/shared/types/sessions";
import { LIKE_ESCAPE_CLAUSE, likeContains, likePrefix } from "./like-pattern";

/** Filters for a session index list query; each maps to one `SessionListQuery` field. */
export interface SessionListFilters {
  status?: SessionStatus;
  excludeStatus?: SessionStatus;
  excludeAutomationLineage?: boolean;
  createdByUserIds?: readonly string[];
  /**
   * Discovery search text, already trimmed and bounded by the shared query
   * codec. See `SessionListQuery.q` for the matching rules; the pattern is
   * bound, never interpolated, and LIKE metacharacters match literally.
   */
  search?: string;
  /** Sessions whose member set (or scalar primary) includes this repository. */
  repository?: { repoOwner: string; repoName: string };
  environmentId?: string;
  /** Exact persisted `spawn_source`; see `SessionListQuery.origin`. */
  spawnSource?: SpawnSource;
}

export interface SessionListPredicates {
  /** A `WHERE …` clause over `sessions`, or an empty string when unfiltered. */
  where: string;
  /** Bound values in clause order. */
  params: unknown[];
}

/**
 * Repository membership over `sessions`: the scalar primary serves sessions
 * that predate `session_repositories`, and the member table serves every
 * position of a multi-repository session. Binds owner, name, owner, name.
 */
export const REPOSITORY_MEMBERSHIP_SQL = `((LOWER(repo_owner) = LOWER(?) AND LOWER(repo_name) = LOWER(?))
  OR EXISTS (
    SELECT 1 FROM session_repositories sr
    WHERE sr.session_id = sessions.id
      AND LOWER(sr.repo_owner) = LOWER(?)
      AND LOWER(sr.repo_name) = LOWER(?)
  ))`;

/** The `WHERE` clause and bindings for a filtered walk of `sessions`. */
export function buildSessionListPredicates(filters: SessionListFilters): SessionListPredicates {
  const {
    status,
    excludeStatus,
    excludeAutomationLineage,
    createdByUserIds,
    search,
    repository,
    environmentId,
    spawnSource,
  } = filters;
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (status) {
    conditions.push("status = ?");
    params.push(status);
  }

  if (excludeStatus) {
    conditions.push("status != ?");
    params.push(excludeStatus);
  }

  if (excludeAutomationLineage) {
    // The "Mine" view excludes sessions no human initiated in the app.
    // github-bot sessions are attributed to the webhook sender (the verified
    // actor), but auto reviews and review-request handling are bot-initiated,
    // so they are lineage-excluded alongside automation runs.
    conditions.push("automation_id IS NULL AND spawn_source NOT IN ('automation', 'github-bot')");
  }

  if (createdByUserIds?.length) {
    conditions.push(`user_id IN (${createdByUserIds.map(() => "?").join(", ")})`);
    params.push(...createdByUserIds);
  }

  if (environmentId) {
    conditions.push("environment_id = ?");
    params.push(environmentId);
  }

  if (spawnSource) {
    conditions.push("spawn_source = ?");
    params.push(spawnSource);
  }

  if (repository) {
    conditions.push(REPOSITORY_MEMBERSHIP_SQL);
    params.push(
      repository.repoOwner,
      repository.repoName,
      repository.repoOwner,
      repository.repoName
    );
  }

  if (search) {
    // SQLite LIKE is case-insensitive for ASCII. The "owner/name" form lets
    // one pattern match an owner, a name, or the joined label; a NULL scalar
    // repository concatenates to NULL and simply fails to match.
    const contains = likeContains(search);
    conditions.push(
      `(title LIKE ? ${LIKE_ESCAPE_CLAUSE}
        OR id LIKE ? ${LIKE_ESCAPE_CLAUSE}
        OR (repo_owner || '/' || repo_name) LIKE ? ${LIKE_ESCAPE_CLAUSE}
        OR EXISTS (
          SELECT 1 FROM session_repositories sr
          WHERE sr.session_id = sessions.id
            AND (sr.repo_owner || '/' || sr.repo_name) LIKE ? ${LIKE_ESCAPE_CLAUSE}
        ))`
    );
    params.push(contains, likePrefix(search), contains, contains);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}
