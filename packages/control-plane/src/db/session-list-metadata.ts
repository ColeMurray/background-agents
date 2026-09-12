import type { PullRequestSummary } from "@open-inspect/shared/types/sessions";
import type { SessionListRepository } from "@open-inspect/shared/types/repositories";
import { MAX_D1_QUERY_PARAMETERS } from "./query-limits";
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

/** Load repository rows and PR summaries in parallel for one D1-safe ID chunk. */
async function loadSessionMetadataChunk(
  db: SqlDatabase,
  pullRequestStore: SessionPullRequestStore,
  sessionIds: string[]
): Promise<{
  repositoryRows: SessionRepositoryRow[];
  summaries: Map<string, PullRequestSummary>;
}> {
  const placeholders = sessionIds.map(() => "?").join(", ");
  const [repositoryResult, summaries] = await Promise.all([
    db
      .prepare(
        `SELECT * FROM session_repositories
         WHERE session_id IN (${placeholders})
         ORDER BY session_id, position`
      )
      .bind(...sessionIds)
      .all<SessionRepositoryRow>(),
    pullRequestStore.summariesForSessions(sessionIds),
  ]);

  return { repositoryRows: repositoryResult.results ?? [], summaries };
}

/**
 * Attach ordered repository membership and PR summaries without changing the
 * input order. Lookups are chunked to stay below D1's parameter limit.
 */
export async function attachSessionListMetadata<T extends { id: string }>(
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
  const chunkResults = await Promise.all(
    chunks.map((chunk) => loadSessionMetadataChunk(db, pullRequestStore, chunk))
  );

  const repositoriesBySession = new Map<string, SessionListRepository[]>();
  for (const row of chunkResults.flatMap((result) => result.repositoryRows)) {
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
    chunkResults.flatMap((result) => [...result.summaries.entries()])
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
