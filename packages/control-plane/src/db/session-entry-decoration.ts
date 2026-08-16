import type { PullRequestSummary } from "@open-inspect/shared/types/sessions";
import type { SessionListRepository } from "@open-inspect/shared/types/repositories";
import { SessionPullRequestStore } from "./session-pull-request-store";
import type { SqlDatabase } from "./sql-database";

interface SessionRepositoryRow {
  session_id: string;
  position: number;
  repo_owner: string;
  repo_name: string;
  repo_id: number | null;
  base_branch: string;
}

export async function decorateSessionEntries<T extends { id: string }>(
  db: SqlDatabase,
  sessions: T[]
): Promise<
  Array<T & { repositories?: SessionListRepository[]; pullRequestSummary?: PullRequestSummary }>
> {
  if (sessions.length === 0) return sessions;
  const sessionIds = sessions.map((session) => session.id);
  const placeholders = sessionIds.map(() => "?").join(", ");

  const [repositoryRows, summariesBySession] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM session_repositories
         WHERE session_id IN (${placeholders})
         ORDER BY session_id, position`
      )
      .bind(...sessionIds)
      .all<SessionRepositoryRow>(),
    new SessionPullRequestStore(db).summariesForSessions(sessionIds),
  ]);

  const repositoriesBySession = new Map<string, SessionListRepository[]>();
  for (const row of repositoryRows.results ?? []) {
    const repositories = repositoriesBySession.get(row.session_id) ?? [];
    repositories.push({
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      repoId: row.repo_id,
      baseBranch: row.base_branch,
    });
    repositoriesBySession.set(row.session_id, repositories);
  }

  return sessions.map((session) => {
    const repositories = repositoriesBySession.get(session.id);
    const pullRequestSummary = summariesBySession.get(session.id);
    return {
      ...session,
      ...(repositories ? { repositories } : {}),
      ...(pullRequestSummary ? { pullRequestSummary } : {}),
    };
  });
}
