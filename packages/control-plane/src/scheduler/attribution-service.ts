import { getUserAuth } from "../auth/user/runtime";
import type { SqlDatabase } from "../db/sql-database";
import type { UserStore } from "../db/user-store";
import type { Logger } from "../logger";
import {
  AmbiguousGitHubIdentityError,
  resolveGitHubEnrichmentForCanonicalUser,
  type GitHubEnrichment,
} from "../session/identity";
import { GitHubAttributionUnavailableError } from "../source-control/github-credential-authority";
import type { SourceControlProviderName } from "../source-control/types";
import type { Env } from "../types";

export interface AutomationAttributionServiceDeps {
  users: UserStore;
  scmProvider: SourceControlProviderName;
  db: SqlDatabase;
  env: Env;
  log: Logger;
}

/** Resolve an admitted user's SCM attribution with the automation fallback policy. */
export class AutomationAttributionService {
  constructor(private readonly deps: AutomationAttributionServiceDeps) {}

  async resolve(userId: string): Promise<GitHubEnrichment | null> {
    const { users, scmProvider, db, env, log } = this.deps;
    if (scmProvider !== "github") return null;
    try {
      return await resolveGitHubEnrichmentForCanonicalUser(
        users,
        userId,
        // Auth configuration is needed only when a linked account lacks a cached profile.
        () => getUserAuth(env, db).api
      );
    } catch (error) {
      if (
        !(error instanceof AmbiguousGitHubIdentityError) &&
        !(error instanceof GitHubAttributionUnavailableError)
      )
        throw error;
      log.warn("GitHub attribution unavailable; continuing without it", {
        event: "scheduler.github_enrichment_unavailable",
        user_id: userId,
        error,
      });
      return null;
    }
  }
}
