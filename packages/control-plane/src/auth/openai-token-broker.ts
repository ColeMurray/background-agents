import { extractOpenAIAccountId, OpenAITokenRefreshError, refreshOpenAIToken } from "./openai";
import { ScopedOAuthSecretsStore, type OAuthSecretScope } from "./scoped-oauth-secrets";
import type { SqlDatabase } from "../db/sql-database";
import type { Logger } from "../logger";

const OPENAI_TOKEN_REFRESH_BUFFER_MS = 5 * 60 * 1000;
const OPENAI_DEFAULT_TOKEN_LIFETIME_MS = 60 * 60 * 1000;
const OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS = 3;
const OPENAI_TOKEN_PERSIST_RETRY_DELAY_MS = 100;
const OPENAI_CONCURRENT_ROTATION_DELAY_MS = 500;
const OPENAI_TOKEN_PERSIST_FAILURE =
  "OpenAI tokens rotated but could not be saved; reconnect OpenAI OAuth";

type OpenAITokenState =
  | { type: "cached"; accessToken: string; expiresIn: number; accountId?: string }
  | { type: "refresh"; refreshToken: string; scope: OAuthSecretScope; accountId?: string };

export type OpenAITokenRefreshResult =
  | { ok: true; accessToken: string; expiresIn?: number; accountId?: string }
  | { ok: false; status: number; error: string };

/** Provider-level broker shared by session adapters and global OAuth consumers. */
export class OpenAITokenBroker {
  private readonly secrets: ScopedOAuthSecretsStore;

  constructor(
    db: SqlDatabase,
    encryptionKey: string,
    private readonly log: Logger
  ) {
    this.secrets = new ScopedOAuthSecretsStore(db, encryptionKey);
  }

  refreshGlobal(): Promise<OpenAITokenRefreshResult> {
    return this.refreshScopes([{ kind: "global" }]);
  }

  refreshScopes(scopes: readonly OAuthSecretScope[]): Promise<OpenAITokenRefreshResult> {
    return this.refreshFrom(() => this.readTokenState(scopes));
  }

  private async refreshFrom(
    readTokenState: () => Promise<OpenAITokenState | null>
  ): Promise<OpenAITokenRefreshResult> {
    let tokenState: OpenAITokenState | null;
    try {
      tokenState = await readTokenState();
    } catch (error) {
      this.log.error("Failed to read OpenAI token state from secrets", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, status: 500, error: "Failed to read token state" };
    }

    if (!tokenState) {
      return { ok: false, status: 404, error: "OPENAI_OAUTH_REFRESH_TOKEN not configured" };
    }

    if (tokenState.type === "cached") {
      return {
        ok: true,
        accessToken: tokenState.accessToken,
        expiresIn: tokenState.expiresIn,
        accountId: tokenState.accountId,
      };
    }

    try {
      return await this.attemptRefresh(tokenState);
    } catch (error) {
      if (error instanceof OpenAITokenRefreshError && error.status === 401) {
        return this.handleUnauthorizedRefresh(tokenState, readTokenState);
      }

      this.log.error("OpenAI token refresh failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return { ok: false, status: 502, error: "OpenAI token refresh failed" };
    }
  }

  private stateFromSecrets(
    secrets: Record<string, string>,
    scope: OAuthSecretScope
  ): OpenAITokenState | null {
    const refreshToken = secrets.OPENAI_OAUTH_REFRESH_TOKEN;
    if (!refreshToken) return null;

    const cachedToken = secrets.OPENAI_OAUTH_ACCESS_TOKEN;
    const expiresAt = Number.parseInt(secrets.OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT || "0", 10);
    const now = Date.now();

    if (cachedToken && expiresAt - now > OPENAI_TOKEN_REFRESH_BUFFER_MS) {
      return {
        type: "cached",
        accessToken: cachedToken,
        expiresIn: Math.floor((expiresAt - now) / 1000),
        accountId: secrets.OPENAI_OAUTH_ACCOUNT_ID,
      };
    }

    return {
      type: "refresh",
      refreshToken,
      scope,
      accountId: secrets.OPENAI_OAUTH_ACCOUNT_ID,
    };
  }

  private async readTokenState(
    scopes: readonly OAuthSecretScope[]
  ): Promise<OpenAITokenState | null> {
    for (const scope of scopes) {
      const state = this.stateFromSecrets(await this.secrets.read(scope), scope);
      if (state) return state;
    }
    return null;
  }

  private async attemptRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>
  ): Promise<OpenAITokenRefreshResult> {
    const tokens = await refreshOpenAIToken(tokenState.refreshToken);
    const accountId = extractOpenAIAccountId(tokens) ?? tokenState.accountId;
    const expiresAt =
      Date.now() +
      (tokens.expires_in === undefined
        ? OPENAI_DEFAULT_TOKEN_LIFETIME_MS
        : tokens.expires_in * 1000);
    const secretsToWrite: Record<string, string> = {
      OPENAI_OAUTH_REFRESH_TOKEN: tokens.refresh_token,
      OPENAI_OAUTH_ACCESS_TOKEN: tokens.access_token,
      OPENAI_OAUTH_ACCESS_TOKEN_EXPIRES_AT: String(expiresAt),
    };
    if (accountId) secretsToWrite.OPENAI_OAUTH_ACCOUNT_ID = accountId;

    const persisted = await this.persistRotatedTokens(tokenState.scope, secretsToWrite);
    if (!persisted) {
      return { ok: false, status: 500, error: OPENAI_TOKEN_PERSIST_FAILURE };
    }

    this.log.info("OpenAI tokens rotated and cached", {
      scope: tokenState.scope.kind,
      has_account_id: !!accountId,
    });
    return {
      ok: true,
      accessToken: tokens.access_token,
      expiresIn: tokens.expires_in,
      accountId,
    };
  }

  private async persistRotatedTokens(
    scope: OAuthSecretScope,
    secrets: Record<string, string>
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS; attempt++) {
      try {
        await this.secrets.write(scope, secrets);
        return true;
      } catch (error) {
        const finalAttempt = attempt === OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS;
        const context = {
          scope: scope.kind,
          attempt,
          max_attempts: OPENAI_TOKEN_PERSIST_MAX_ATTEMPTS,
          error: error instanceof Error ? error.message : String(error),
        };
        if (finalAttempt) {
          this.log.error("Failed to store rotated OpenAI tokens", context);
          return false;
        }
        this.log.warn("Failed to store rotated OpenAI tokens; retrying", context);
        await new Promise((resolve) => setTimeout(resolve, OPENAI_TOKEN_PERSIST_RETRY_DELAY_MS));
      }
    }
    return false;
  }

  private async handleUnauthorizedRefresh(
    tokenState: Extract<OpenAITokenState, { type: "refresh" }>,
    readTokenState: () => Promise<OpenAITokenState | null>
  ): Promise<OpenAITokenRefreshResult> {
    this.log.warn("OpenAI refresh got 401, checking for concurrent rotation", {
      scope: tokenState.scope.kind,
    });
    await new Promise((resolve) => setTimeout(resolve, OPENAI_CONCURRENT_ROTATION_DELAY_MS));

    try {
      const reread = await readTokenState();
      if (reread?.type === "cached") {
        this.log.info("Using cached access token from concurrent rotation");
        return {
          ok: true,
          accessToken: reread.accessToken,
          expiresIn: reread.expiresIn,
          accountId: reread.accountId,
        };
      }
      if (reread?.type === "refresh" && reread.refreshToken !== tokenState.refreshToken) {
        this.log.info("Detected concurrent token rotation, retrying");
        return this.attemptRefresh(reread);
      }
    } catch (error) {
      this.log.error("Retry after 401 also failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return { ok: false, status: 401, error: "OpenAI token refresh failed: unauthorized" };
  }
}
