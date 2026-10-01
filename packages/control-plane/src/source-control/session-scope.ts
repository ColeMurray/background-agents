import { SessionIndexStore } from "../db/session-index";
import type { SqlDatabase } from "../db/sql-database";
import type { CredentialScope } from "./credential-scope";
import { SourceControlProviderError } from "./errors";
import { resolveTeamTokenScope } from "./team-scope";

/** Resolve scope from fresh D1 session ownership before reading current team grants. */
export async function resolveSessionCredentialScope(
  db: SqlDatabase,
  sessionId: string
): Promise<CredentialScope> {
  const session = await new SessionIndexStore(db).get(sessionId);
  if (!session) {
    throw new SourceControlProviderError(
      "Cannot resolve credential scope: session not found",
      "permanent"
    );
  }
  return resolveTeamTokenScope(db, session.ownerTeamId);
}
