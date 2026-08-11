import { OpenAITokenBroker, type OpenAITokenRefreshResult } from "../auth/openai-token-broker";
import type { OAuthSecretScope } from "../auth/scoped-oauth-secrets";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";
import type { SessionRow } from "./types";

export type { OpenAITokenRefreshResult } from "../auth/openai-token-broker";

/** Resolves a session into OAuth secret scopes before delegating to the provider broker. */
export class OpenAITokenRefreshService {
  private readonly broker: OpenAITokenBroker;

  constructor(
    db: SqlDatabase,
    encryptionKey: string,
    private readonly ensureRepoId: (session: SessionRow) => Promise<number>,
    private readonly log: Logger
  ) {
    this.broker = new OpenAITokenBroker(db, encryptionKey, log);
  }

  async refresh(session: SessionRow): Promise<OpenAITokenRefreshResult> {
    let sessionScope: OAuthSecretScope | null;
    try {
      sessionScope = await this.resolveSessionScope(session);
    } catch (error) {
      this.log.error("Failed to resolve OpenAI token secret scope", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, status: 500, error: "Failed to read token state" };
    }
    const scopes: OAuthSecretScope[] = sessionScope
      ? [sessionScope, { kind: "global" }]
      : [{ kind: "global" }];
    return this.broker.refreshScopes(scopes);
  }

  private async resolveSessionScope(session: SessionRow): Promise<OAuthSecretScope | null> {
    if (session.environment_id) {
      return { kind: "environment", environmentId: session.environment_id };
    }
    if (session.repo_owner && session.repo_name) {
      return {
        kind: "repo",
        repoId: await this.ensureRepoId(session),
        repoOwner: session.repo_owner,
        repoName: session.repo_name,
      };
    }
    return null;
  }
}
