import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { SessionIndexStore } from "../db/session-index";
import { SessionRepositoryStore } from "../db/session-repositories";
import type { SqlDatabase } from "../db/sql-database";
import type { CredentialScope } from "./credential-scope";
import { SourceControlProviderError } from "./errors";
import { resolveRepositoryCredentialScope } from "./repository-scope";

/** Resolve fresh ownership and persisted session members, never environment provenance. */
export async function resolveSessionCredentialScope(
  db: SqlDatabase,
  sessionId: string,
  loadInstallationRepositories: () => Promise<InstallationRepository[]>
): Promise<CredentialScope> {
  const session = await new SessionIndexStore(db).get(sessionId);
  if (!session) {
    throw new SourceControlProviderError(
      "Cannot resolve credential scope: session not found",
      "permanent"
    );
  }
  const members = await new SessionRepositoryStore(db).listRepositoryIds(sessionId);
  const repositories = members.length
    ? members
    : session.repoOwner && session.repoName
      ? [{ repoOwner: session.repoOwner, repoName: session.repoName, repoId: null }]
      : [];
  return await resolveRepositoryCredentialScope(
    db,
    repositories,
    session.ownerTeamId,
    loadInstallationRepositories
  );
}
