import type { PullRequestSummary } from "@open-inspect/shared/types/sessions";
import type { SessionListRepository } from "@open-inspect/shared/types/repositories";
import { SessionPullRequestStore } from "./session-pull-request-store";
import type { SqlDatabase } from "./sql-database";

const MAX_D1_QUERY_PARAMETERS = 100;

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
  const chunks: string[][] = [];
  for (let start = 0; start < sessionIds.length; start += MAX_D1_QUERY_PARAMETERS) {
    chunks.push(sessionIds.slice(start, start + MAX_D1_QUERY_PARAMETERS));
  }

  const pullRequestStore = new SessionPullRequestStore(db);
  const [repositoryResults, summaryResults] = await Promise.all([
    Promise.all(
      chunks.map((chunk) =>
        db
          .prepare(
            `SELECT * FROM session_repositories
             WHERE session_id IN (${chunk.map(() => "?").join(", ")})
             ORDER BY session_id, position`
          )
          .bind(...chunk)
          .all<SessionRepositoryRow>()
      )
    ),
    Promise.all(chunks.map((chunk) => pullRequestStore.summariesForSessions(chunk))),
  ]);

  const repositoriesBySession = new Map<string, SessionListRepository[]>();
  for (const row of repositoryResults.flatMap((result) => result.results ?? [])) {
    const repositories = repositoriesBySession.get(row.session_id) ?? [];
    repositories.push({
      repoOwner: row.repo_owner,
      repoName: row.repo_name,
      repoId: row.repo_id,
      baseBranch: row.base_branch,
    });
    repositoriesBySession.set(row.session_id, repositories);
  }
  const summariesBySession = new Map(
    summaryResults.flatMap((summaries) => [...summaries.entries()])
  );

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
