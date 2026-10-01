import type { InstallationRepository } from "@open-inspect/shared/types/repository-catalog";
import { SessionIndexStore } from "../db/session-index";
import { SessionScopeStore } from "../db/session-scope-store";
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
  const repositories = await new SessionScopeStore(db).listRepositoryIds(sessionId);
  return await resolveRepositoryCredentialScope(
    db,
    repositories,
    session.ownerTeamId,
    loadInstallationRepositories
  );
}
