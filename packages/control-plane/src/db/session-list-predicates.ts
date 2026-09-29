import { normalizeOptionalRepositoryPair } from "@open-inspect/shared/types/repositories";
import type { SessionStatus, SpawnSource } from "@open-inspect/shared/types/sessions";
import type { SessionListQuery } from "@open-inspect/shared/session-list-query";
import type { SessionViewer } from "@open-inspect/shared";
import type { TeamsEnforcementMode } from "../authorization/teams-enforcement";
import { LIKE_ESCAPE_CLAUSE, likeContains, likePrefix } from "./like-pattern";
import { visibleSessionsPredicate } from "./session-visibility";

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
  /** Sessions whose member set (or scalar primary) includes this repository; identifiers are normalized here. */
  repository?: { repoOwner: string; repoName: string };
  environmentId?: string;
  /** Exact persisted `spawn_source`; see `SessionListQuery.origin`. */
  spawnSource?: SpawnSource;
  teamIds?: readonly string[];
  ownerFilter?: SessionListQuery["ownerFilter"];
  visibility?: SessionListQuery["visibility"];
  scope?: SessionListQuery["scope"];
  viewer?: SessionViewer;
  mode?: TeamsEnforcementMode;
}

export interface SessionListPredicates {
  /** A `WHERE …` clause over `sessions`, or an empty string when unfiltered. */
  where: string;
  /** Bound values in clause order. */
  params: unknown[];
}

/**
 * Repository membership over `sessions` by exact, normalized identity: the
 * scalar primary (via `idx_sessions_repo`) or any member row (via
 * `idx_session_repositories_repo`), so SQLite serves the filter as a
 * multi-index OR over the candidate set instead of walking history. Both
 * columns have been written trimmed and lowercased since #859; sessions from
 * before that with mixed-case scalar identifiers are deliberately not
 * matched here (search still finds them, as LIKE folds ASCII case).
 * Binds owner, name, owner, name.
 */
const REPOSITORY_MEMBERSHIP_SQL = `((repo_owner = ? AND repo_name = ?)
  OR sessions.id IN (
    SELECT session_id FROM session_repositories
    WHERE repo_owner = ? AND repo_name = ?
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
    teamIds,
    ownerFilter,
    visibility,
    scope,
    viewer,
    mode,
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

  if (teamIds?.length) {
    conditions.push(`owner_team_id IN (${teamIds.map(() => "?").join(", ")})`);
    params.push(...teamIds);
  }

  if (scope === "workspace") conditions.push("owner_team_id IS NULL");
  if (visibility) {
    conditions.push("visibility = ?");
    params.push(visibility);
  }
  if (ownerFilter === "started" && viewer?.kind === "user") {
    conditions.push("user_id = ?");
    params.push(viewer.userId);
  }
  if (ownerFilter === "participating" && viewer?.kind === "user") {
    conditions.push(`(user_id = ? OR EXISTS (
      SELECT 1 FROM session_collaborators sc WHERE sc.session_id = sessions.id AND sc.user_id = ?
    ) OR EXISTS (
      SELECT 1 FROM session_read_states rs WHERE rs.session_id = sessions.id AND rs.user_id = ?
    ))`);
    params.push(viewer.userId, viewer.userId, viewer.userId);
  }

  if (environmentId) {
    conditions.push("environment_id = ?");
    params.push(environmentId);
  }

  if (spawnSource) {
    conditions.push("spawn_source = ?");
    params.push(spawnSource);
  }

  const normalizedRepository = repository ? normalizeOptionalRepositoryPair(repository) : null;
  if (normalizedRepository) {
    conditions.push(REPOSITORY_MEMBERSHIP_SQL);
    params.push(
      normalizedRepository.repoOwner,
      normalizedRepository.repoName,
      normalizedRepository.repoOwner,
      normalizedRepository.repoName
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

  if (viewer) {
    const visible = visibleSessionsPredicate("sessions", viewer, { mode });
    conditions.push(visible.sql);
    params.push(...visible.params);
  }

  return {
    where: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    params,
  };
}
