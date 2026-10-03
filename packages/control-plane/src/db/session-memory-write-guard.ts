import type { MemoryScope } from "@open-inspect/shared/types/memories";

/**
 * Commit-time authority for an agent write, evaluated inside the memory insert.
 * Mirrors workspace/team grant semantics without trusting earlier route reads:
 * the session must still be live, its owner active, and its exact target available.
 * A fresh prompt must reactivate a settled session before tools can write again.
 */
export function sessionMemoryWriteGuard(
  sessionId: string,
  userId: string | null,
  scope: MemoryScope,
  repoId: number | null
): { sql: string; values: unknown[] } {
  let target: string;
  let values: unknown[];
  if (scope.type === "personal") {
    target = `EXISTS (SELECT 1 FROM session_memory_manifests manifest
      WHERE manifest.session_id = s.id AND manifest.include_personal_memories = 1
        AND manifest.personal_owner_user_id = s.user_id)`;
    values = [];
  } else if (scope.type === "environment") {
    target = `EXISTS (SELECT 1 FROM environments e WHERE e.id = ? AND e.id = s.environment_id
      AND (e.owner_team_id IS NULL OR e.owner_team_id = s.owner_team_id))`;
    values = [scope.environmentId];
  } else {
    target = `EXISTS (SELECT 1 FROM session_repositories sr
      WHERE sr.session_id = s.id AND sr.repo_id = ? AND sr.repo_id > 0
        AND lower(sr.repo_owner) = lower(?) AND lower(sr.repo_name) = lower(?)
        AND (
          (s.owner_team_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM team_repository_grants g WHERE g.team_id = s.owner_team_id
              AND (g.grant_kind = 'installation' OR g.repo_external_id = sr.repo_id)
          )) OR (s.owner_team_id IS NULL AND (
            r.key IN ('owner', 'administrator')
            OR NOT EXISTS (SELECT 1 FROM team_repository_grants g
              WHERE g.grant_kind = 'installation' OR g.repo_external_id = sr.repo_id)
            OR EXISTS (SELECT 1 FROM team_repository_grants g
              JOIN team_memberships tm ON tm.team_id = g.team_id AND tm.user_id = s.user_id
              JOIN teams t ON t.id = g.team_id AND t.archived_at IS NULL
              WHERE g.grant_kind = 'installation' OR g.repo_external_id = sr.repo_id)
          ))
        ))`;
    values = [repoId, scope.repoOwner, scope.repoName];
  }
  return {
    sql: `AND EXISTS (SELECT 1 FROM sessions s
      JOIN users u ON u.id = s.user_id AND u.suspended_at IS NULL
      JOIN user_role_assignments a ON a.user_id = u.id JOIN roles r ON r.id = a.role_id
      WHERE s.id = ? AND s.user_id = ? AND s.status IN ('created', 'active')
        AND (s.owner_team_id IS NULL OR EXISTS (
          SELECT 1 FROM teams t WHERE t.id = s.owner_team_id AND t.archived_at IS NULL
        )) AND ${target})`,
    values: [sessionId, userId, ...values],
  };
}
